import 'dotenv/config';
import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import Record from './server/models/Record.js';
import PendingPatient from './server/models/PendingPatient.js';
import TelemetryLog from './server/models/TelemetryLog.js';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import crypto from 'crypto';
import { ethers } from 'ethers';
// Reloj monotónico de alta resolución para medir duraciones (no le afectan los ajustes NTP del
// reloj del sistema). Devuelve ms con decimales desde el arranque del proceso: solo es válido restar
// dos lecturas del mismo proceso (t1 - t0), nunca compararlo con Date.now().
import { performance } from 'perf_hooks';
import { serializeForHash } from './src/shared/hashPayload';
import { missingNarrativeFields, missingRequiredTriageFields } from './src/shared/requiredFields';
import { isAdmissionWallet } from './src/shared/roles';
import { AuthError, Role, createLoginMessage, login, logout, requireRole, sessionOf } from './server/auth';

const app = express();
const PORT = 3000;

// ─────────────────────────────────────────────────────────────
// CONFIGURACIÓN DE FIRMA INVISIBLE EN EL BACKEND (RELAYER/CUSTODIAL)
// ─────────────────────────────────────────────────────────────
// Sin clave por defecto ni wallet aleatoria: si RELAYER_PRIVATE_KEY falta o es inválida, el servidor
// arranca (admisión, historial e IA no dependen del Relayer), pero toda operación que firme o ancle
// en blockchain falla explícitamente vía getRelayerWallet().
const PUBLIC_EXAMPLE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let relayerWallet: ethers.Wallet | null = null;
let relayerConfigError: string | null = null;
{
  const rawKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (!rawKey) {
    relayerConfigError = 'RELAYER_PRIVATE_KEY no está definida en el .env';
  } else if (rawKey.toLowerCase() === PUBLIC_EXAMPLE_KEY) {
    relayerConfigError = 'RELAYER_PRIVATE_KEY es la clave de ejemplo pública, no una clave real';
  } else {
    try {
      relayerWallet = new ethers.Wallet(rawKey);
    } catch (e: any) {
      relayerConfigError = `RELAYER_PRIVATE_KEY es inválida (${e.shortMessage || e.message})`;
    }
  }
  if (relayerWallet) {
    console.log(`[RELAYER] Billetera de Firma Invisible en Servidor inicializada. Dirección: ${relayerWallet.address}`);
  } else {
    console.error(`[RELAYER] ⚠️ Relayer NO configurado: ${relayerConfigError}. El guardado de triages (firma y anclaje en Polygon) fallará hasta corregirlo.`);
  }
}

// Devuelve la wallet del Relayer o lanza un error claro si no está configurada correctamente.
function getRelayerWallet(): ethers.Wallet {
  if (!relayerWallet) {
    throw new Error(`Relayer no configurado correctamente: ${relayerConfigError}.`);
  }
  return relayerWallet;
}

// SHA-256 determinístico del registro clínico. Los campos incluidos y la serialización vienen de
// src/shared/hashPayload.ts, la misma definición que usa el cliente para verificar la integridad.
function generateHashBackend(data: any): string {
  return crypto.createHash('sha256').update(serializeForHash(data)).digest('hex');
}

// Firma criptográficamente el hash usando la clave privada del servidor (ECDSA con SECP256K1)
// Firma ECDSA del hash con la clave del Relayer. Fail-closed: si la firma falla se lanza el error y el
// guardado completo se aborta (no se genera ninguna firma sustituta ni se guarda el registro).
async function signHashBackend(dataHash: string): Promise<string> {
  const wallet = getRelayerWallet(); // Fuera del try: el error "Relayer no configurado" llega tal cual
  try {
    return await wallet.signMessage(ethers.getBytes(ethers.id(dataHash)));
  } catch (err: any) {
    console.error('[RELAYER] Falló la firma ECDSA del hash; el registro no se guardará:', err.message || err);
    throw new Error(`No se pudo firmar el registro con la clave del Relayer: ${err.shortMessage || err.message || err}`);
  }
}

// Resultado de la verificación on-chain: distingue "no autorizado" (el contrato respondió
// y la wallet no es doctor ni owner) de "no se pudo verificar" (sin RPC configurado, o la
// llamada al contrato falló) — son situaciones distintas y no deben reportarse igual al cliente.
type DoctorAuthResult = { authorized: boolean; reason: 'OK' | 'NOT_A_REGISTERED_DOCTOR' | 'RPC_NOT_CONFIGURED' | 'VERIFICATION_FAILED' };

// Verifica en la Blockchain (lectura, sin gas) que la wallet del médico esté autorizada:
// registrada en el mapping `doctors` del contrato, o sea el `owner` (a quien el modificador
// onlyDoctor también permite). Fail-closed: cualquier incapacidad de completar la verificación
// (RPC no configurado, o error en la llamada al contrato) se trata como NO autorizado.
async function verifyDoctorAuthorization(doctorAddress: string): Promise<DoctorAuthResult> {
  const rpcUrl = process.env.POLYGON_RPC_URL;
  const contractAddress = "0xa7e1c47b30Ef1a30E3cd46edD2147B4Eed7E6D6A";

  if (!rpcUrl) {
    console.error('[AUTH] POLYGON_RPC_URL no configurado: no se puede verificar autorización on-chain del médico (fail-closed, rechazando).');
    return { authorized: false, reason: 'RPC_NOT_CONFIGURED' };
  }

  try {
    const amoyNetwork = { chainId: 80002, name: 'polygon-amoy' };
    const provider = new ethers.JsonRpcProvider(rpcUrl, amoyNetwork, { staticNetwork: true });
    const abi = [
      "function isDoctor(address _user) external view returns (bool)",
      "function owner() external view returns (address)"
    ];
    const readOnlyContract = new ethers.Contract(contractAddress, abi, provider);

    const [isDoctorOnChain, ownerAddress] = await Promise.all([
      readOnlyContract.isDoctor(doctorAddress),
      readOnlyContract.owner()
    ]);

    const authorized = isDoctorOnChain || ownerAddress.toLowerCase() === doctorAddress.toLowerCase();
    return { authorized, reason: authorized ? 'OK' : 'NOT_A_REGISTERED_DOCTOR' };
  } catch (err: any) {
    console.error('[AUTH] Error verificando autorización on-chain del médico (fail-closed, rechazando):', err.message || err);
    return { authorized: false, reason: 'VERIFICATION_FAILED' };
  }
}

// Roles de una cuenta, consultados en el contrato (lectura, sin gas) al iniciar sesión: DOCTOR si está
// en el mapping `doctors`, ADMIN si es el `owner()`, AUDITOR si está en `auditors`; ADMISSION por la lista
// compartida (src/shared/roles.ts). Una cuenta puede tener varios roles. Fail-closed: si el contrato no
// se puede consultar, se lanza el error y no se abre la sesión.
async function resolveRoles(address: string): Promise<Role[]> {
  const roles: Role[] = [];
  if (isAdmissionWallet(address)) roles.push('ADMISSION');
  const rpcUrl = process.env.POLYGON_RPC_URL;
  if (!rpcUrl) throw new AuthError(503, 'POLYGON_RPC_URL no está configurado: no se pueden verificar los roles en el contrato');
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: 80002, name: 'polygon-amoy' }, { staticNetwork: true });
    const contract = new ethers.Contract("0xa7e1c47b30Ef1a30E3cd46edD2147B4Eed7E6D6A", [
      "function isDoctor(address _user) external view returns (bool)",
      "function isAuditor(address _user) external view returns (bool)",
      "function owner() external view returns (address)"
    ], provider);
    const [isDoctor, isAuditor, owner] = await Promise.all([contract.isDoctor(address), contract.isAuditor(address), contract.owner()]);
    if (isDoctor) roles.push('DOCTOR');
    if (owner.toLowerCase() === address.toLowerCase()) roles.push('ADMIN');
    if (isAuditor) roles.push('AUDITOR');
  } catch (err: any) {
    console.error('[AUTH] No se pudieron consultar los roles en el contrato (fail-closed):', err.message || err);
    throw new AuthError(503, 'No se pudieron verificar los roles en el contrato inteligente');
  }
  return roles;
}

// Intervalo de sondeo del proveedor RPC para tx.wait(). ethers v6 usa 4000 ms por defecto, lo que
// cuantiza t_minado en saltos de ~4 s. El error de medición es de hasta un intervalo de sondeo, así que
// se usa 1000 ms (por debajo del tiempo de bloque de Amoy, ~2 s) para validar RNF-01 (≤ 5 s).
const RPC_POLLING_INTERVAL_MS = 1000;

// Ejecuta la transacción real contra Polygon Amoy (con desglose de métricas).
// Sin simulación: si no hay RPC/relayer configurado o la transacción falla, se lanza el error y el
// registro NO se guarda (no se generan hashes de transacción ni tiempos ficticios).
async function registerTriageBackendDetails(patientId: string, dataHash: string, triageLevel: number, aiReasoningHash: string): Promise<{ txHash: string; t_prop_ms: number; t_minado_ms: number; gasUsed: string | null; effectiveGasPrice: string | null; costPol: string | null }> {
  const rpcUrl = process.env.POLYGON_RPC_URL;
  const contractAddress = "0xa7e1c47b30Ef1a30E3cd46edD2147B4Eed7E6D6A";
  
  // Seudonimiza la cédula con SHA-256 + sal para que no llegue en claro a Polygon. Sin sal por defecto:
  // una sal escrita en el código es pública y permitiría recuperar las cédulas por fuerza bruta, así que
  // si PATIENT_SALT falta se rechaza el anclaje (fail-closed, igual que el Relayer).
  const PATIENT_SALT = process.env.PATIENT_SALT?.trim();
  if (!PATIENT_SALT) {
    throw new Error('PATIENT_SALT no está definida en el .env; no se ancla el registro para no exponer la cédula con una sal conocida.');
  }
  const anonymizedPatientId = patientId.startsWith('ANON-')
    ? patientId
    : `ANON-${crypto.createHash('sha256').update((patientId || '00000') + PATIENT_SALT).digest('hex').substring(0, 16).toUpperCase()}`;

  const relayer = getRelayerWallet();
  if (!rpcUrl) {
    throw new Error('Relayer no configurado correctamente: POLYGON_RPC_URL no está definida; no se puede anclar el registro en Polygon Amoy.');
  }

  try {
    const amoyNetwork = { chainId: 80002, name: 'polygon-amoy' };
    const provider = new ethers.JsonRpcProvider(rpcUrl, amoyNetwork, {
      staticNetwork: true,
      pollingInterval: RPC_POLLING_INTERVAL_MS
    });
    const backendSigner = relayer.connect(provider);
    const abi = [
      "function registerTriage(string _patientIdAnonymized, string _dataHash, uint8 _triageLevel, string _aiReasoningHash) external"
    ];
    const contract = new ethers.Contract(contractAddress, abi, backendSigner);

    const t_prop_start = performance.now();
    const tx = await contract.registerTriage(anonymizedPatientId, dataHash, triageLevel, aiReasoningHash);
    const t_prop_ms = Number((performance.now() - t_prop_start).toFixed(3));

    const t_minado_start = performance.now();
    const receipt = await tx.wait(1);
    const t_minado_ms = Number((performance.now() - t_minado_start).toFixed(3));

    // Costo real del recibo. En ethers v6, receipt.gasPrice es el effectiveGasPrice que devuelve el RPC
    // (puede faltar). Todo en bigint/wei, sin redondeo; el costo en POL se entrega como texto decimal
    // exacto (formatEther). Si falta cualquiera de los dos datos → null, sin valores de relleno.
    const gasUsedBig = receipt?.gasUsed ?? null;
    const gasPriceBig = receipt?.gasPrice ?? null;
    const gasUsed = gasUsedBig !== null ? gasUsedBig.toString() : null;
    const effectiveGasPrice = gasPriceBig !== null ? gasPriceBig.toString() : null;
    const costPol = gasUsedBig !== null && gasPriceBig !== null ? ethers.formatEther(gasUsedBig * gasPriceBig) : null;
    return { txHash: tx.hash, t_prop_ms, t_minado_ms, gasUsed, effectiveGasPrice, costPol };
  } catch (err: any) {
    console.error("[RELAYER] Falló la transacción real en Polygon Amoy; el registro no se guardará:", err.message || err);
    throw new Error(`No se pudo anclar el registro en Polygon Amoy: ${err.shortMessage || err.message || err}`);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// AUTENTICACIÓN (server/auth.ts): firma de un mensaje con la wallet → token de sesión
// ─────────────────────────────────────────────────────────────
app.get('/api/auth/nonce', (req: Request, res: Response) => {
  try {
    res.json({ message: createLoginMessage(String(req.query.address || '')) });
  } catch (err: any) {
    res.status(err instanceof AuthError ? err.status : 500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { address, signature } = req.body || {};
    res.json(await login(address, signature, resolveRoles));
  } catch (err: any) {
    res.status(err instanceof AuthError ? err.status : 500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  logout(req);
  res.json({ success: true });
});

let aiClient: GoogleGenAI | null = null;
function getGeminiClient() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("API Key for Gemini is missing. Please set GEMINI_API_KEY environment variable.");
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

// --- ROUTES ---

// AI Symptoms Analyzer
app.post('/api/triage/analyze', requireRole('DOCTOR', 'ADMIN'), async (req: Request, res: Response) => {
  const t_ai_start = performance.now();
  try {
    const { symptoms, currentIllness, patientInfo, vitals, gcsTotal, hasShock, shockType, selectedModifiers } = req.body;

    // Motivo de consulta y enfermedad actual son obligatorios (misma regla que el cliente,
    // src/shared/requiredFields.ts). Se rechaza antes de consultar a la IA.
    const missingNarrative = missingNarrativeFields({ symptoms, currentIllness });
    if (missingNarrative.length > 0) {
      return res.status(400).json({
        error: 'Campos obligatorios faltantes',
        message: `Complete los campos obligatorios: ${missingNarrative.join(', ')}.`,
        missingFields: missingNarrative
      });
    }
    const clinicalText = `${symptoms} | ${currentIllness}`;
    
    let ai;
    try {
      ai = getGeminiClient();
    } catch (keyError: any) {
      return res.status(400).json({
        error: "Falta configuración de IA",
        message: "No se ha configurado la clave de la API de Gemini (GEMINI_API_KEY) en el servidor de AI Studio. Por favor, revísalo en la sección de Secretos."
      });
    }

    const clinicalPrompt = `
Eres un sistema experto e inteligente de Triage Clínico de Emergencias para Colombia (bajo la Resolución 5596 de 2015 y la escala Canadiense/Americana ESI - Emergency Severity Index).
Analiza detalladamente el relato libre recopilado por el médico ("motivo de consulta, enfermedad actual y antecedentes") junto con los signos objetivos provistos del paciente para clasificar el nivel de Triage adecuado guiándote strictly bajo estas especificaciones:

--- VARIABLES OBJETIVAS DEL PACIENTE ---
Edad: ${patientInfo?.age || 'Desconocida'}
Género/Sexo: ${patientInfo?.gender || 'Desconocido'}
EPS del paciente: ${patientInfo?.eps || 'No especificada'}

Signos Vitales actuales:
- Frecuencia Cardíaca (FC): ${vitals?.heartRate !== undefined && vitals.heartRate !== '' ? vitals.heartRate + ' lpm' : 'No registrada'}
- Frecuencia Respiratoria (FR): ${vitals?.respiratoryRate !== undefined && vitals.respiratoryRate !== '' ? vitals.respiratoryRate + ' rpm' : 'No registrada'}
- Tensión Arterial Sistólica (PAS): ${vitals?.sysBP !== undefined && vitals.sysBP !== '' ? vitals.sysBP + ' mmHg' : 'No registrada'}
- Tensión Arterial Diastólica (PAD): ${vitals?.diaBP !== undefined && vitals.diaBP !== '' ? vitals.diaBP + ' mmHg' : 'No registrada'}
- Saturación de Oxígeno (SpO2): ${vitals?.spo2 !== undefined && vitals.spo2 !== '' ? vitals.spo2 + '%' : 'No registrada'}
- Temperatura corporal: ${vitals?.temperature !== undefined && vitals.temperature !== '' ? vitals.temperature + ' °C' : 'No registrada'}
Escala de Coma de Glasgow (vía examinación): GCS = ${gcsTotal || 'Desconocido'}
Estado o sospecha de Shock: ${hasShock ? 'SÍ, de tipo ' + (shockType || 'Sin tipificar') : 'NO'}

Factores modificadores seleccionados preliminarmente:
- Gestante/Embarazo: ${selectedModifiers?.gestante ? 'SÍ' : 'NO'}
- Adulto Mayor (>65 años): ${selectedModifiers?.adultoMayor ? 'SÍ' : 'NO'}
- Lactante (<1 año): ${selectedModifiers?.lactante ? 'SÍ' : 'NO'}
- Inmunosuprimido: ${selectedModifiers?.inmunosuprimido ? 'SÍ' : 'NO'}
- Paciente oncológico: ${selectedModifiers?.oncologico ? 'SÍ' : 'NO'}

--- TEXTO LIBRE MÉDICO (Motivo de Consulta y Síntomas) ---
"${clinicalText}"

--- REGLAS DEL PROTOCOLO DE CLASIFICACIÓN ---
1. TRIAGE I  - Reanimación (Riesgo vital inmediato):
   Paro cardiorrespiratorio, obstrucción completa de vía aérea, dificultad respiratoria severa (SpO2 < 90% o FR > 30), inconsciencia, crisis convulsiva activa, déficit neurológico focal agudo grave, politraumatismo grave, trauma craneoencefálico grave, hemorragia masiva, shock (cualquier tipo de shock o PAS < 70), eclampsia, hemorragia obstétrica severa, mordedura de serpiente (ofidismo), intoxicación por plaguicidas, Glasgow <= 8.
2. TRIAGE II  - Emergencia (Alto riesgo, hemodinámicamente inestables o dolor extremo):
   Dolor torácico opresivo sugestivo de infarto/síndrome coronario agudo, palpitaciones inestables, dificultad respiratoria moderada (SpO2 90-94%, FR 24-30), crisis asmática moderada-severa, alteración aguda del estado mental (e.g., desorientación súbita), convulsión reciente pero no activa, cefalea súbita e intensa tipo trueno, hernia estrangulada, fractura expuesta, quemadura severa o química, heridas penetrantes, hemorragia activa moderada, sospecha de infección grave, fiebre extrema con signos de alarma, reacciones alérgicas moderadas-graves, anafilaxia, preeclampsia, sangrado vaginal durante el embarazo, violencia sexual, paciente agresivo o potencialmente peligroso, sospecha de intoxicación aguda o sobredosis. Glasgow entre 9 y 13.
3. TRIAGE III  - Urgencia (Condición aguda que requiere recursos múltiples pero estable):
   Síntomas respiratorios moderados sin compromiso severo de oxigenación, trauma moderado sin deformación extrema, fractura cerrada, luxación, dolor abdominal moderado a severo, vómito persistente sin deshidratación grave, diarrea con deshidratación moderada, cólico renal agudo, retención urinaria aguda, fiebre persistente sin otros signos de alarma, síndrome febril de origen a determinar, sospecha de violencia intrafamiliar con lesiones menores.
4. TRIAGE IV  - Prioritario (Condición subaguda o crónica reagudizada que requiere un recurso simple o ninguno):
   Infección respiratoria leve, tos seca ordinaria, resfriado común, esguince leve sin incapacidad funcional mayor, herida superficial/raspadura, dolor lumbar de características mecánicas, otalgia simple, conjuntivitis, dolor de garganta menor.
5. TRIAGE V  - No urgente (Problemas administrativos, controles o síntomas crónicos sin urgencia):
   Control médico ambulatorio, renovación de recetas/fórmulas, expedición de certificados, curación de heridas ya programada, retiro de puntos, procedures menores ordenados previamente.

--- REGLA DE DESEMPATE ANTE CRITERIOS COINCIDENTES ---
Determina primero el nivel base con esta regla y aplica después la regla de factores modificadores.
Si el relato clínico o los signos vitales cumplen criterios explícitos de más de un nivel de Triage, asigna el nivel más urgente (el de menor número) entre los que apliquen.
Si el relato describe hallazgos concretos que sugieren un criterio de mayor gravedad aunque no lo cumplan de forma literal, prioriza el nivel más urgente compatible con esos hallazgos y menciónalo en la justificación.
Un dato ausente ("No registrada" o "Desconocido") no es por sí solo motivo para subir de nivel: clasifica con la información disponible e indica en la justificación qué datos faltaron.

--- REGLA DE MEJORA DE NIVEL POR FACTORES MODIFICADORES ---
Si el nivel base determinado por síntomas/signos vitales es III, IV o V, la presencia de al menos uno de los siguientes factores modificadores aumentará la prioridad (restará 1 al número del nivel, ej: de III pasa a II; de IV pasa a III; de V pasa a IV):
- Paciente gestante (embarazo activo).
- Adulto Mayor (> 65 años).
- Lactante (< 1 año).
- Paciente inmunosuprimido de cualquier tipo.
- Paciente en tratamiento oncológico activo.
*Nota*: Si el nivel inicial ya es I o II, los factores modificadores no cambian la clasificación (continúan en I o II).

Por favor, analiza la descripción textual libre y realiza:
1. Reconocimiento y extracción de los síntomas o diagnósticos clínicos hallados en el texto libre. Coincídelos semánticamente contra la lista oficial colombiana si es posible.
2. Identificación de los factores modificadores según la lectura del texto libre y correlación médica.
3. Clasificación y asignación objetiva del Nivel de Triage definitivo de acuerdo con la cascada de reglas clínicas y parámetros.
4. Redacción de una justificación/razonamiento clínico conciso y riguroso en español orientados a un colega médico.

Devuelve la información estructurada bajo el formato JSON definido.
`;

    // Modelos priorizados por velocidad (Lite primero para respuesta en ~1-2s) y disponibilidad sin sobrecarga 503
    const tryModels = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash"];
    // thinkingBudget: 0 solo en los modelos que lo aceptan (verificado el 2026-09-28 con una llamada
    // mínima a cada uno): gemini-3.5-flash-lite lo rechaza con 400 INVALID_ARGUMENT, lo que hacía
    // fallar siempre el primer intento de la cascada. En 3.1-flash-lite y 3.6-flash desactiva el
    // razonamiento (sin él, 3.6-flash genera tokens de "thoughts").
    const supportsThinkingBudgetZero: Record<string, boolean> = {
      "gemini-3.5-flash-lite": false,
      "gemini-3.1-flash-lite": true,
      "gemini-3.6-flash": true,
    };
    let lastError: any = null;
    let success = false;

    // Modelos probados hasta obtener respuesta (incluye los intentos fallidos o por timeout)
    let modelsTried = 0;
    for (const modelName of tryModels) {
      if (success) break;
      modelsTried++;
      try {
        console.log(`[AI] Intentando análisis de triage con modelo rápido: ${modelName}`);
        
        // Timeout de seguridad por intento para no bloquear la respuesta clínica
        const generatePromise = ai.models.generateContent({
          model: modelName,
          contents: clinicalPrompt,
          config: {
            responseMimeType: "application/json",
            // Desactiva el razonamiento ("thinking") para reducir la latencia, solo donde el modelo lo acepta
            ...(supportsThinkingBudgetZero[modelName] ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                extractedSymptoms: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Lista de síntomas o condiciones clínicas reconocidas y detectadas en el texto libre que influyen directamente en la clasificación del Triage."
                },
                aiLevel: {
                  type: Type.INTEGER,
                  description: "El nivel de clasificación de Triage finalmente sugerido (un número del 1 al 5)."
                },
                explanation: {
                  type: Type.STRING,
                  description: "Justificación clínica corta, clara y formal en español del porqué la IA sugiere esta clasificación de Triage, citando qué reglas se aplicaron."
                },
                modifiersDetected: {
                  type: Type.OBJECT,
                  properties: {
                    gestante: { type: Type.BOOLEAN, description: "Indica si el texto libre describe explícitamente embarazo o estado gestacional." },
                    adultoMayor: { type: Type.BOOLEAN, description: "Indica si se detecta que el paciente entra en la categoría de adulto mayor (>65 años)." },
                    lactante: { type: Type.BOOLEAN, description: "Indica si se detecta que el paciente es lactante (<1 año)." },
                    inmunosuprimido: { type: Type.BOOLEAN, description: "Indica si se detectan antecedentes de inmunosupresión." },
                    oncologico: { type: Type.BOOLEAN, description: "Indica si presenta antecedentes oncológicos o quimioterapia." }
                  },
                  required: ["gestante", "adultoMayor", "lactante", "inmunosuprimido", "oncologico"]
                },
                datosFaltantes: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Lista de los datos clínicos relevantes que no estaban disponibles al momento del análisis (por ejemplo, \"Glasgow no evaluado\", \"PA no registrada\"). Lista vacía si no faltó ninguno."
                }
              },
              required: ["extractedSymptoms", "aiLevel", "explanation", "modifiersDetected", "datosFaltantes"]
            }
          }
        });

        // Límite de 6 segundos por modelo para respuesta ágil en Triage
        const response: any = await Promise.race([
          generatePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout de 6s en modelo ${modelName}`)), 6000))
        ]);

        const responseText = response.text?.trim() || "";
        if (responseText) {
          const parsedResponse = JSON.parse(responseText);
          const t_gemini_ms = Number((performance.now() - t_ai_start).toFixed(3));
          console.log(`[AI] Análisis de triage completado exitosamente con ${modelName} en ${t_gemini_ms}ms`);
          // Tokens del intento que respondió (los intentos fallidos no devuelven usageMetadata).
          // Salida = candidatos + "thoughts" (se facturan como salida; con thinkingBudget 0 no debería haber).
          // Ausente → null, sin valores de relleno.
          const usage = response.usageMetadata;
          const tokensIn = typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : null;
          const tokensOut = typeof usage?.candidatesTokenCount === 'number'
            ? usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0)
            : null;
          res.json({
            ...parsedResponse,
            _metrics: {
              gemini_ms: t_gemini_ms,
              modelUsed: modelName,
              modelsTried,
              tokensIn,
              tokensOut
            }
          });
          success = true;
          break;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[AI] Modelo ${modelName} no disponible (${err.status || err.message}). Pasando de inmediato al siguiente modelo alternativo...`);
      }
    }

    if (!success) {
      throw lastError || new Error("Se agotaron todos los modelos candidatos sin una respuesta válida.");
    }

  } catch (error: any) {
    console.error('Error in AI analysis endpoint:', error);
    res.status(500).json({ 
      error: 'Fallo en la consulta de IA', 
      message: error.message || String(error), 
      details: error.stack || error.message 
    });
  }
});

// ─────────────────────────────────────────────────────────────
// CONTROL DE CONEXIÓN EXCLUSIVA A MONGODB LOCAL (SIN ALTERNATIVAS)
// ─────────────────────────────────────────────────────────────
const LOCAL_MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/medichain_thesis';

// Middleware: Rechaza de inmediato con error si MongoDB Local no está conectado
const ensureLocalMongo = (req: Request, res: Response, next: any) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: 'MongoDB Local no disponible',
      message: `No se pudo conectar a MongoDB Local (${LOCAL_MONGO_URI}). La aplicación está configurada exclusivamente para MongoDB local y no utiliza alternativas. Por favor inicie el servicio de MongoDB en su máquina.`,
      readyState: mongoose.connection.readyState
    });
  }
  next();
};

// RNF-07: Middleware — la simulación de ataques (manipulación directa de la BD) solo funciona si se
// habilita de forma explícita con ENABLE_ATTACK_SIMULATION=true y fuera de producción. Fail-closed:
// si la variable falta o tiene otro valor, la ruta queda deshabilitada aunque NODE_ENV no esté definida.
// Se ejecuta ANTES que ensureLocalMongo para que el bloqueo por entorno sea la primera barrera,
// independiente del estado de conexión de la base de datos.
const blockInProduction = (req: Request, res: Response, next: any) => {
  const simulationEnabled = process.env.ENABLE_ATTACK_SIMULATION === 'true' && process.env.NODE_ENV !== 'production';
  if (!simulationEnabled) {
    return res.status(403).json({ error: 'Forbidden: attack simulation is disabled (set ENABLE_ATTACK_SIMULATION=true outside production to enable it)' });
  }
  next();
};

// 1.1 Create a new Triage Record with Invisible Backend Signing (Meta-Transactions / Relayer approach)
app.post('/api/records/invisible', requireRole('DOCTOR', 'ADMIN'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const { patientData, doctorWallet } = req.body;
    
    if (!patientData) {
      return res.status(400).json({ error: "Missing patientData in request body" });
    }

    // Campos obligatorios (relato, 6 signos vitales y las 3 subescalas de Glasgow; misma regla que el cliente,
    // src/shared/requiredFields.ts). Falla cerrado: se rechaza antes de verificar al médico,
    // hashear, firmar o anclar en Polygon.
    const missingFields = missingRequiredTriageFields(patientData);
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Campos obligatorios faltantes',
        details: `Complete los campos obligatorios: ${missingFields.join(', ')}.`,
        missingFields
      });
    }

    // aiLevel / aiModelUsed: se validan y normalizan ANTES de hashear y anclar, para que Mongoose no
    // rechace después un registro que ya quedó anclado en Polygon. Ausente → null.
    const aiLevel = patientData.aiLevel ?? null;
    if (aiLevel !== null && !(Number.isInteger(Number(aiLevel)) && Number(aiLevel) >= 1 && Number(aiLevel) <= 5)) {
      return res.status(400).json({ error: "patientData.aiLevel must be null or an integer between 1 and 5" });
    }
    const aiModelUsed = patientData.aiModelUsed ?? null;
    if (aiModelUsed !== null && typeof aiModelUsed !== 'string') {
      return res.status(400).json({ error: "patientData.aiModelUsed must be null or a string" });
    }
    patientData.aiLevel = aiLevel === null ? null : Number(aiLevel);
    patientData.aiModelUsed = aiModelUsed;
    // aiExplanation (RF-21): texto, o ausente. Vacío o null se elimina para que el hash no lo incluya.
    if (patientData.aiExplanation != null && typeof patientData.aiExplanation !== 'string') {
      return res.status(400).json({ error: "patientData.aiExplanation must be a string when present" });
    }
    if (!patientData.aiExplanation) delete patientData.aiExplanation;

    // Nivel final (obligatorio, lo asigna el médico) y nivel sugerido (el de la IA, o null si no se
    // ejecutó el análisis). También se validan antes de anclar, por la misma razón que aiLevel.
    const isEsiLevel = (v: unknown) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5;
    if (patientData.finalEsiLevel == null || !isEsiLevel(patientData.finalEsiLevel)) {
      return res.status(400).json({ error: "patientData.finalEsiLevel must be an integer between 1 and 5" });
    }
    const suggested = patientData.suggestedEsiLevel ?? null;
    if (suggested !== null && !isEsiLevel(suggested)) {
      return res.status(400).json({ error: "patientData.suggestedEsiLevel must be null or an integer between 1 and 5" });
    }
    patientData.finalEsiLevel = Number(patientData.finalEsiLevel);
    patientData.suggestedEsiLevel = suggested === null ? null : Number(suggested);

    // Verificar en la Blockchain que la wallet del médico esté autorizada ANTES de hashear/firmar/registrar nada.
    const doctorId = patientData.doctorId;
    if (!doctorId) {
      return res.status(400).json({ error: "Missing patientData.doctorId for authorization check" });
    }
    // El médico del registro debe ser quien inició la sesión (firmó con esa wallet): ya no basta con
    // escribir en la petición la dirección de otro médico registrado.
    if (String(doctorId).toLowerCase() !== sessionOf(req).address.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden: patientData.doctorId no corresponde a la wallet de la sesión' });
    }
    const authResult = await verifyDoctorAuthorization(doctorId);
    if (!authResult.authorized) {
      if (authResult.reason === 'NOT_A_REGISTERED_DOCTOR') {
        return res.status(403).json({ error: 'Forbidden: wallet is not an authorized doctor on the smart contract' });
      }
      // RPC_NOT_CONFIGURED o VERIFICATION_FAILED: no se pudo determinar la autorización (no es lo mismo
      // que "no autorizado"), así que se rechaza fail-closed con un error distinto y más claro.
      return res.status(503).json({
        error: 'Service Unavailable: could not verify on-chain doctor authorization',
        reason: authResult.reason
      });
    }

    // A. Calculate SHA-256 hash deterministically on the backend to guarantee data integrity
    const t_hash_start = performance.now();
    const dataHash = generateHashBackend(patientData);
    const t_hash_ms = Number((performance.now() - t_hash_start).toFixed(3));
    
    // B. Generate real ECDSA cryptographic signature using backend private key (Relayer/System wallet)
    const t_firma_start = performance.now();
    const signature = await signHashBackend(dataHash);
    const t_firma_ms = Number((performance.now() - t_firma_start).toFixed(3));

    // C. Ancla en Polygon Amoy. Fail-closed: si la transacción no se confirma, se lanza el error y no se guarda nada.
    // We embed the doctor's MetaMask address visibly in plain text within the reason/metadata string
    // Format: "DOC:0x123...|ACTION:..." so Polygonscan directly displays the physician's wallet!
    const doctorAddressClean = (doctorWallet || patientData.doctorId || "0xANONYMOUS_DOCTOR").trim();
    // RNF-05: solo etiquetas fijas en la cadena, nunca texto clínico libre. El motivo de la corrección
    // queda en MongoDB y forma parte del dataHash (correctionReason en hashPayload.ts).
    // NO_AI: sin sugerencia de IA; AI_MATCH: el médico aceptó el nivel de la IA; MD_OVERRIDE: lo cambió.
    // Los registros anteriores a quitar el motor de reglas usan ALGO_MATCH en lugar de AI_MATCH.
    const actionTag = patientData.correctionReason
      ? "CORR"
      : patientData.suggestedEsiLevel === null
        ? "NO_AI"
        : (patientData.suggestedEsiLevel === patientData.finalEsiLevel ? "AI_MATCH" : "MD_OVERRIDE");
    
    const plainTextMetadataOnChain = `DOC:${doctorAddressClean}|${actionTag}`;
      
    const bcDetails = await registerTriageBackendDetails(
      patientData.cedula,
      dataHash,
      patientData.finalEsiLevel,
      plainTextMetadataOnChain
    );

    // D. Save to Database
    const t_db_start = performance.now();
    const newRecord = new Record({
      patientData,
      blockchainHash: dataHash,
      blockchainSignature: signature,
      transactionHash: bcDetails.txHash
    });

    await newRecord.save();
    const t_db_ms = Number((performance.now() - t_db_start).toFixed(3));

    console.log(`[RELAYER] Record registered and signed invisibly on Backend. Doctor: ${doctorWallet} | Relayer: ${getRelayerWallet().address} | TX: ${bcDetails.txHash}`);
    
    const recordObj = newRecord.toObject();
    res.status(201).json({
      ...recordObj,
      _metrics: {
        t_hash_ms,
        t_firma_ms,
        t_prop_ms: bcDetails.t_prop_ms,
        t_minado_ms: bcDetails.t_minado_ms,
        t_bc_ms: bcDetails.t_prop_ms + bcDetails.t_minado_ms,
        t_db_ms,
        gasUsed: bcDetails.gasUsed,
        effectiveGasPrice: bcDetails.effectiveGasPrice,
        costPol: bcDetails.costPol
      }
    });
  } catch (error: any) {
    console.error('Error in backend invisible signing:', error);
    res.status(500).json({ error: 'Server Error during backend signing', details: error.message });
  }
});

// 2. Get All Records (For Auditor View)
app.get('/api/records', requireRole('DOCTOR', 'AUDITOR', 'ADMIN'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const records = await Record.find().sort({ createdAt: -1 });
    res.json(records);
  } catch (error: any) {
    res.status(500).json({ error: 'Server Error fetching records', details: error.message });
  }
});

// 3. Mark as Attended (Update attentionTimestamp)
app.patch('/api/records/:id/attend', requireRole('DOCTOR'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { attentionTimestamp } = req.body;

    const updated = await Record.findOneAndUpdate(
      { _id: id },
      { $set: { "patientData.attentionTimestamp": attentionTimestamp } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: 'Record not found' });
    res.json(updated);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update attention time', details: error.message });
  }
});

// 4. ADMIN BACKDOOR (The Hack)
app.patch('/api/hack/:id', blockInProduction, requireRole('ADMIN'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const { id } = req.params; // MongoDB _id
    // La sesión ya se verificó (requireRole('ADMIN')); adminWallet, si viene de un cliente anterior, se ignora
    const { adminWallet: _ignored, ...hackedData } = req.body;

    const record = await Record.findById(id);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    // Apply the hack: Update patientData fields.
    // record.patientData es un subdocumento de Mongoose: hacer spread de él copia sus propiedades
    // internas ($__, _doc) y Mongoose lo trata como el mismo subdocumento, ignorando hackedData.
    // Por eso se parte de toObject() del documento (un objeto plano con los campos reales).
    record.set('patientData', { ...record.toObject().patientData, ...hackedData });
    
    await record.save();
    console.log(`[WARNING] Record ${id} was manually altered (HACKED)`);
    
    res.json({ success: true, message: 'Data injection successful (Integrity Compromised)' });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: 'Hack failed', details: error.message });
  }
});

// 5. ADMISSION: Add patient to waiting list
app.post('/api/pending-patients', requireRole('ADMISSION'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const { cedula, name, age, gender, eps } = req.body;
    const newPending = new PendingPatient({ cedula, name, age, gender, eps });
    await newPending.save();
    res.status(201).json(newPending);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to add to waiting list', details: error.message });
  }
});

// 6. WAITING LIST: Get all pending patients
app.get('/api/pending-patients', requireRole('ADMISSION', 'DOCTOR'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const pending = await PendingPatient.find().sort({ admissionTimestamp: 1 });
    res.json(pending);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch waiting list', details: error.message });
  }
});

// 7. REMOVE: After triage, remove from list
app.delete('/api/pending-patients/:id', requireRole('ADMISSION', 'DOCTOR'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    await PendingPatient.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to remove from waiting list', details: error.message });
  }
});

// Campos de costo por triage (gas del recibo y tokens de Gemini). Todos null si no hay dato real:
// no se sustituyen por 0 ni por valores de relleno. Los valores en wei/POL llegan como texto decimal
// exacto; los que no son un número válido se descartan (null).
const nullableInt = (v: any): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const nullableDecimalString = (v: any): string | null => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : null);
function telemetryCostFields(logData: any) {
  return {
    gas_used: nullableInt(logData.gas_used),
    effective_gas_price_wei: nullableDecimalString(logData.effective_gas_price_wei),
    cost_pol: nullableDecimalString(logData.cost_pol),
    ai_tokens_in: nullableInt(logData.ai_tokens_in),
    ai_tokens_out: nullableInt(logData.ai_tokens_out),
    ai_models_tried: nullableInt(logData.ai_models_tried),
  };
}

// 8. TELEMETRY LOGS (PERSISTED IN MONGODB FOR THESIS REPRODUCIBILITY)
app.get('/api/telemetry/logs', requireRole('ADMIN'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const logs = await TelemetryLog.find().sort({ timestamp: -1 }).limit(500);
    const mapped = logs.map(doc => ({
      id: doc.logId,
      timestamp: doc.timestamp,
      patientName: doc.patientName,
      t_iot: doc.t_iot,
      isBleConnected: doc.isBleConnected,
      t_ai: doc.t_ai,
      t_db_hash: doc.t_db_hash,
      t_ui: doc.t_ui,
      t_blockchain: doc.t_blockchain,
      t_hash_ms: doc.t_hash_ms ?? null,
      t_firma_ms: doc.t_firma_ms ?? null,
      ...telemetryCostFields(doc),
      isRealMeasurement: doc.isRealMeasurement,
      errorReason: doc.errorReason
    }));
    res.json(mapped);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch telemetry logs from MongoDB', details: error.message });
  }
});

app.post('/api/telemetry/logs', requireRole('DOCTOR', 'ADMIN'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const logData = req.body;
    const doc = new TelemetryLog({
      logId: logData.id || `TL-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: logData.timestamp || Date.now(),
      patientName: logData.patientName || 'Paciente Prueba',
      t_iot: logData.t_iot !== undefined ? logData.t_iot : null,
      isBleConnected: !!logData.isBleConnected,
      t_ai: typeof logData.t_ai === 'number' ? logData.t_ai : null,
      t_db_hash: logData.t_db_hash || 0,
      t_ui: typeof logData.t_ui === 'number' ? logData.t_ui : null,
      t_blockchain: typeof logData.t_blockchain === 'number' ? logData.t_blockchain : null,
      t_hash_ms: typeof logData.t_hash_ms === 'number' ? logData.t_hash_ms : null,
      t_firma_ms: typeof logData.t_firma_ms === 'number' ? logData.t_firma_ms : null,
      ...telemetryCostFields(logData),
      isRealMeasurement: logData.isRealMeasurement !== false,
      errorReason: logData.errorReason || ''
    });
    await doc.save();
    res.status(201).json(doc);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to save telemetry log to MongoDB', details: error.message });
  }
});

app.post('/api/telemetry/batch', requireRole('ADMIN'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    const logsData: any[] = req.body.logs || [];
    const docs = logsData.map(logData => ({
      logId: logData.id || `TL-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      timestamp: logData.timestamp || Date.now(),
      patientName: logData.patientName || 'Paciente Prueba',
      t_iot: logData.t_iot !== undefined ? logData.t_iot : null,
      isBleConnected: !!logData.isBleConnected,
      t_ai: typeof logData.t_ai === 'number' ? logData.t_ai : null,
      t_db_hash: logData.t_db_hash || 0,
      t_ui: typeof logData.t_ui === 'number' ? logData.t_ui : null,
      t_blockchain: typeof logData.t_blockchain === 'number' ? logData.t_blockchain : null,
      t_hash_ms: typeof logData.t_hash_ms === 'number' ? logData.t_hash_ms : null,
      t_firma_ms: typeof logData.t_firma_ms === 'number' ? logData.t_firma_ms : null,
      ...telemetryCostFields(logData),
      isRealMeasurement: logData.isRealMeasurement !== false,
      errorReason: logData.errorReason || ''
    }));
    await TelemetryLog.insertMany(docs, { ordered: false });
    res.status(201).json({ count: docs.length });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to batch save telemetry logs', details: error.message });
  }
});

app.delete('/api/telemetry/logs', requireRole('ADMIN'), ensureLocalMongo, async (req: Request, res: Response) => {
  try {
    await TelemetryLog.deleteMany({});
    res.json({ success: true, message: 'All telemetry logs deleted from MongoDB' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to clear telemetry logs', details: error.message });
  }
});

async function connectDatabase() {
  try {
    console.log(`[MongoDB] Intentando conectar EXCLUSIVAMENTE a MongoDB Local: ${LOCAL_MONGO_URI}...`);
    await mongoose.connect(LOCAL_MONGO_URI, {
      serverSelectionTimeoutMS: 3000
    });
    console.log(`✅ Conexión exitosa a MongoDB Local (${LOCAL_MONGO_URI})`);
    await seedPendingPatients();
  } catch (err: any) {
    console.error(`❌ ERROR CRÍTICO: No se pudo conectar a MongoDB Local (${LOCAL_MONGO_URI}).`);
    console.error(`Detalle: ${err.message || err}`);
    console.error(`[AVISO] Configurado para conectarse ÚNICAMENTE a su base de datos MongoDB local. No se usarán bases en memoria ni otras alternativas.`);
  }
}

async function startServer() {
  // Vite Middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: false
      },
      appType: 'spa',
      clearScreen: false,
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Por defecto solo acepta conexiones del propio equipo (127.0.0.1). Para abrirlo a la red local hay que
  // definir HOST=0.0.0.0 de forma explícita en el .env.
  const HOST = process.env.HOST?.trim() || '127.0.0.1';
  app.listen(PORT, HOST, () => {
    console.log(`🚀 Server running on http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  });

  // Conectar a base de datos de manera asíncrona sin bloquear el inicio del servidor HTTP
  connectDatabase().catch(err => {
    console.error('Error conectando a la base de datos:', err);
  });
}

async function seedPendingPatients() {
  try {
    const count = await PendingPatient.countDocuments();
    if (count === 0) {
      const mockPatients = [
        {
          cedula: '1020485934',
          name: 'Carlos Alberto Gómez Restrepo',
          age: 45,
          gender: 'M',
          eps: 'SURA',
          admissionTimestamp: Date.now() - 120 * 60000 // hace 2 horas
        },
        {
          cedula: '1035987654',
          name: 'María Camila Giraldo Toro',
          age: 28,
          gender: 'F',
          eps: 'Sanitas',
          admissionTimestamp: Date.now() - 90 * 60000 // hace 1.5 horas
        },
        {
          cedula: '1047890123',
          name: 'Jorge Eliécer Mendoza Villegas',
          age: 72,
          gender: 'M',
          eps: 'Nueva EPS',
          admissionTimestamp: Date.now() - 60 * 60000 // hace 1 hora
        },
        {
          cedula: '1098765432',
          name: 'Sofía Valentina Ortega Ruiz',
          age: 9,
          gender: 'F',
          eps: 'Salud Total',
          admissionTimestamp: Date.now() - 30 * 60000 // hace 30 minutos
        },
        {
          cedula: '1102456789',
          name: 'Andrés Felipe Villa Posada',
          age: 34,
          gender: 'M',
          eps: 'Compensar',
          admissionTimestamp: Date.now() - 15 * 60000 // hace 15 minutos
        }
      ];
      await PendingPatient.insertMany(mockPatients);
      console.log('🌱 Seeded 5 default pending patients into the waiting list.');
    }
  } catch (err) {
    console.error('❌ Error seeding pending patients:', err);
  }
}

startServer();

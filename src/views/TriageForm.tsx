import React, { useState, useEffect, useRef } from 'react';
import { ESILevel } from '../types';
import type { PatientData, VitalSigns, GlasgowScale, HybridRecord, PendingPatient } from '../types';
import { BluetoothDeviceController } from '../services/bluetoothService';
import type { IoTData, IoTDiagEvent } from '../services/bluetoothService';
import { Activity, Bluetooth, Save, RefreshCw, AlertTriangle, FileWarning, Brain, HeartPulse, Sun, Moon, Users, CheckCircle } from 'lucide-react';
import { dbService } from '../services/databaseService';
import { telemetryService } from '../services/telemetryService';
import { missingNarrativeFields, missingRequiredTriageFields } from '../shared/requiredFields';
import { addMinutes } from 'date-fns';

// Glasgow en el formulario: cada subescala es null hasta que el médico elige un valor. No hay
// valor por defecto (antes 4/5/6 = 15), para que un Glasgow no evaluado no se guarde como normal.
type GlasgowInput = { eyeOpening: number | null; verbalResponse: number | null; motorResponse: number | null; total: number | null };
const EMPTY_GLASGOW: GlasgowInput = { eyeOpening: null, verbalResponse: null, motorResponse: null, total: null };

// Estados del ensayo de captura IoT que ve el médico
type BleSensorState = 'esperando_dedo' | 'midiendo' | 'senal_deficiente' | 'estable' | 'incompleto' | 'timeout';

// Ensayo en curso. Se guarda en un ref porque los callbacks BLE se registran una sola vez al conectar.
interface BleTrial {
  fingerOn: boolean;          // Contacto del dedo registrado en este ensayo
  sawFingerOff: boolean;      // La sesión ya vio "sin dedo": el siguiente contacto es un inicio real
  contactSeen: boolean;       // El inicio del ensayo se observó en vivo (el cronómetro es válido)
  startedAt: number | null;   // performance.now() estimado del contacto
  captured: boolean;          // Ya se llenó el formulario con el paquete ready de este ensayo
  firmwareTime: boolean;      // t_iot ya viene de CAPTURA_LISTA del ESP32
}
const newBleTrial = (): BleTrial => ({
  fingerOn: false, sawFingerOff: false, contactSeen: false, startedAt: null, captured: false, firmwareTime: false
});
// El ESP32 confirma el dedo tras 20 muestras a 100 Hz; su t = 0 es la primera de ellas
const FINGER_CONFIRM_MS = 200;

interface TriageFormProps {
  walletAddress: string;
  initialData?: HybridRecord;
  isReEvaluation?: boolean;
  onSuccess?: () => void;
}

// ─────────────────────────────────────────────────────────────────
// GLASGOW OPTIONS — sin cambios
// ─────────────────────────────────────────────────────────────────
const GLASGOW_OPTIONS = {
  eye: [
    { val: 4, label: "Espontánea (4)" },
    { val: 3, label: "A la orden verbal (3)" },
    { val: 2, label: "Al dolor (2)" },
    { val: 1, label: "Ninguna (1)" }
  ],
  verbal: [
    { val: 5, label: "Orientado (5)" },
    { val: 4, label: "Desorientado (4)" },
    { val: 3, label: "Palabras inapropiadas (3)" },
    { val: 2, label: "Sonidos incomprensibles (2)" },
    { val: 1, label: "Ninguna (1)" }
  ],
  motor: [
    { val: 6, label: "Obedece órdenes (6)" },
    { val: 5, label: "Localiza el dolor (5)" },
    { val: 4, label: "Retirada al dolor (4)" },
    { val: 3, label: "Flexión anormal (3)" },
    { val: 2, label: "Extensión anormal (2)" },
    { val: 1, label: "Ninguna (1)" }
  ]
};


// ─────────────────────────────────────────────────────────────────
// UMBRALES DE SIGNOS VITALES
// Basado en ESI v4 + Res. 5596 de 2015 + protocolo Clínica Colombia
// ─────────────────────────────────────────────────────────────────
const VITAL_THRESHOLDS = {
  fc:   { t1_low: 40,   t1_high: 150, t2_low: 50,   t2_high: 140 },
  spo2: { t1: 90,       t2: 94 },
  fr:   { t1_high: 30,  t2_high: 24,  t2_low: 10 },
  pas:  { t1: 70,       t2_low: 90,   t2_high: 180 },
  temp: { t1_high: 40.5, t1_low: 35.0, t2_high: 39.5, t2_low: 35.5 },
} as const;

// ─────────────────────────────────────────────────────────────────
// TIPOS PARA EL RESULTADO DEL ALGORITMO
// ─────────────────────────────────────────────────────────────────
export interface TriageReason {
  factor: 'glasgow' | 'vitals' | 'symptom' | 'shock' | 'modifier';
  description: string;
  suggestedLevel: ESILevel;
}

export interface TriageResult {
  level: ESILevel;
  reasons: TriageReason[];
  modifiersApplied: string[];
}

// ─────────────────────────────────────────────────────────────────
// ALGORITMO PRINCIPAL — calcularTriage
// Regla: el factor más grave predomina (cascada descendente)
// EVA: dato informativo, NO define nivel automáticamente
// ─────────────────────────────────────────────────────────────────
const calcularTriage = (
  gcsTotal: number,
  fr: number,
  fc: number,
  pas: number,
  sato2: number,
  temperatura: number,
  symptoms: string[],  // incluye 'Shock Hipovolémico', etc.
  modifiers: {
    gestante: boolean;
    adultoMayor: boolean;
    lactante: boolean;
    inmunosuprimido: boolean;
    oncologico: boolean;
  }
): TriageResult => {

  const reasons: TriageReason[] = [];
  const modifiersApplied: string[] = [];
  let worstLevel: ESILevel = ESILevel.FIVE;

  const evaluate = (
    condition: boolean,
    factor: TriageReason['factor'],
    description: string,
    level: ESILevel
  ) => {
    if (condition) {
      reasons.push({ factor, description, suggestedLevel: level });
      if (level < worstLevel) worstLevel = level;
    }
  };

  // ── 1. GLASGOW ───────────────────────────────────────────────
  if (gcsTotal > 0) {
    evaluate(gcsTotal <= 8,  'glasgow', `GCS ${gcsTotal} ≤ 8 → coma / trauma grave`, ESILevel.ONE);
    evaluate(gcsTotal >= 9 && gcsTotal <= 13, 'glasgow', `GCS ${gcsTotal} entre 9–13 → compromiso neurológico moderado`, ESILevel.TWO);
  }

  // ── 2. FRECUENCIA CARDÍACA ───────────────────────────────────
  if (fc > 0) {
    evaluate(fc < VITAL_THRESHOLDS.fc.t1_low || fc > VITAL_THRESHOLDS.fc.t1_high,
      'vitals', `FC ${fc} lpm ${fc < 40 ? '< 40' : '> 150'} → inestabilidad hemodinámica crítica`, ESILevel.ONE);
    evaluate(fc >= VITAL_THRESHOLDS.fc.t1_low && fc < VITAL_THRESHOLDS.fc.t2_low,
      'vitals', `FC ${fc} lpm entre 40–50 → bradicardia significativa`, ESILevel.TWO);
    evaluate(fc > VITAL_THRESHOLDS.fc.t2_high && fc <= VITAL_THRESHOLDS.fc.t1_high,
      'vitals', `FC ${fc} lpm entre 140–150 → taquicardia moderada`, ESILevel.TWO);
  }

  // ── 3. SpO₂ ─────────────────────────────────────────────────
  if (sato2 > 0) {
    evaluate(sato2 < VITAL_THRESHOLDS.spo2.t1,
      'vitals', `SpO₂ ${sato2}% < 90 → hipoxia crítica`, ESILevel.ONE);
    evaluate(sato2 >= VITAL_THRESHOLDS.spo2.t1 && sato2 < VITAL_THRESHOLDS.spo2.t2,
      'vitals', `SpO₂ ${sato2}% entre 90–94 → hipoxia moderada`, ESILevel.TWO);
  }

  // ── 4. FRECUENCIA RESPIRATORIA ───────────────────────────────
  if (fr > 0) {
    evaluate(fr > VITAL_THRESHOLDS.fr.t1_high,
      'vitals', `FR ${fr} rpm > 30 → insuficiencia respiratoria grave`, ESILevel.ONE);
    evaluate(fr > VITAL_THRESHOLDS.fr.t2_high && fr <= VITAL_THRESHOLDS.fr.t1_high,
      'vitals', `FR ${fr} rpm entre 24–30 → taquipnea moderada`, ESILevel.TWO);
    evaluate(fr > 0 && fr < VITAL_THRESHOLDS.fr.t2_low,
      'vitals', `FR ${fr} rpm < 10 → bradipnea`, ESILevel.TWO);
  }

  // ── 5. PRESIÓN ARTERIAL SISTÓLICA ────────────────────────────
  if (pas > 0) {
    evaluate(pas < VITAL_THRESHOLDS.pas.t1,
      'vitals', `TA sistólica ${pas} mmHg < 70 → colapso circulatorio / shock`, ESILevel.ONE);
    evaluate(pas >= VITAL_THRESHOLDS.pas.t1 && pas < VITAL_THRESHOLDS.pas.t2_low,
      'vitals', `TA sistólica ${pas} mmHg entre 70–90 → hipotensión moderada`, ESILevel.TWO);
    evaluate(pas > VITAL_THRESHOLDS.pas.t2_high,
      'vitals', `TA sistólica ${pas} mmHg > 180 → HTA severa`, ESILevel.TWO);
  }

  // ── 6. TEMPERATURA ───────────────────────────────────────────
  if (temperatura > 0) {
    evaluate(temperatura > VITAL_THRESHOLDS.temp.t1_high,
      'vitals', `Temperatura ${temperatura}°C > 40.5 → hipertermia grave`, ESILevel.ONE);
    evaluate(temperatura < VITAL_THRESHOLDS.temp.t1_low,
      'vitals', `Temperatura ${temperatura}°C < 35 → hipotermia`, ESILevel.ONE);
    evaluate(temperatura >= VITAL_THRESHOLDS.temp.t1_low && temperatura < VITAL_THRESHOLDS.temp.t2_low,
      'vitals', `Temperatura ${temperatura}°C entre 35–35.5 → hipotermia leve`, ESILevel.TWO);
    evaluate(temperatura > VITAL_THRESHOLDS.temp.t2_high && temperatura <= VITAL_THRESHOLDS.temp.t1_high,
      'vitals', `Temperatura ${temperatura}°C entre 39.5–40.5 → fiebre alta`, ESILevel.TWO);
  }

  // ── 7. SHOCK ─────────────────────────────────────────────────
  // Cualquier tipo de shock confirmado → T1 directo
  const shockSymptom = symptoms.find(s => s.toLowerCase().startsWith('shock'));
  evaluate(!!shockSymptom, 'shock',
    `Shock confirmado: ${shockSymptom && shockSymptom !== 'Shock (Sin tipificar)'
      ? shockSymptom.replace('Shock ', '')
      : 'sin tipificar'}`,
    ESILevel.ONE);

  // ── 8. FACTORES MODIFICADORES ────────────────────────────────
  // Suben el nivel calculado en 1 si aplica.
  // Solo actúan si el nivel base es T3, T4 o T5 (no empeoran ya un T1/T2).
  // Nunca deben modificar Triage I o II.
  const applyModifier = (condition: boolean, description: string) => {
    if (condition && worstLevel > ESILevel.TWO) {
      modifiersApplied.push(description);
      worstLevel = (worstLevel - 1) as ESILevel;
      reasons.push({
        factor: 'modifier',
        description: `Modificador aplicado: ${description} → nivel subido un grado`,
        suggestedLevel: worstLevel,
      });
    }
  };

  applyModifier(modifiers.gestante, 'Gestante');
  applyModifier(modifiers.adultoMayor, 'Adulto mayor > 65 años');
  applyModifier(modifiers.lactante, 'Lactante < 1 año');
  applyModifier(modifiers.inmunosuprimido, 'Inmunosuprimido');
  applyModifier(modifiers.oncologico, 'Paciente oncológico');

  return { level: worstLevel, reasons, modifiersApplied };
};

// ─────────────────────────────────────────────────────────────────
// HELPERS DE UI — sin cambios respecto al original
// ─────────────────────────────────────────────────────────────────
const getTriageColor = (level: ESILevel) => {
  switch (level) {
    case ESILevel.ONE:   return 'bg-red-600 text-white border-red-500 shadow-[0_0_20px_rgba(220,38,38,0.6)]';
    case ESILevel.TWO:   return 'bg-orange-500 text-white border-orange-400 shadow-[0_0_20px_rgba(249,115,22,0.6)]';
    case ESILevel.THREE: return 'bg-yellow-400 text-slate-900 border-yellow-300 shadow-[0_0_20px_rgba(250,204,21,0.6)]';
    case ESILevel.FOUR:  return 'bg-green-500 text-white border-green-400 shadow-[0_0_20px_rgba(34,197,94,0.6)]';
    case ESILevel.FIVE:  return 'bg-blue-500 text-white border-blue-400 shadow-[0_0_20px_rgba(59,130,246,0.6)]';
    default:             return 'bg-slate-800 text-slate-300 border-slate-700';
  }
};

const getTriageLabel = (level: ESILevel) => {
  switch (level) {
    case ESILevel.ONE:   return 'I - REANIMACIÓN';
    case ESILevel.TWO:   return 'II - EMERGENCIA';
    case ESILevel.THREE: return 'III - URGENCIA';
    case ESILevel.FOUR:  return 'IV - CONSULTA PRIORITARIA';
    case ESILevel.FIVE:  return 'V - CONSULTA EXTERNA';
    default:             return 'NO DEFINIDO';
  }
};

const getAttentionTime = (level: ESILevel) => {
  const map = { 1: 0, 2: 30, 3: 180, 4: 1440, 5: 4320 };
  return map[level as keyof typeof map];
};

const formatAttentionTime = (minutes: number) => {
  if (minutes === 0) return 'Atención Inmediata';
  if (minutes < 60)  return `Dentro de ${minutes} minutos`;
  const hours = minutes / 60;
  return hours < 24 ? `Dentro de ${hours} horas` : `Dentro de ${hours / 24} días`;
};

// ─────────────────────────────────────────────────────────────────
// COMPONENTE PRINCIPAL
// ─────────────────────────────────────────────────────────────────
export const TriageForm: React.FC<TriageFormProps> = ({ walletAddress, initialData, isReEvaluation, onSuccess }) => {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const isCorrectionMode = !!initialData && !isReEvaluation;
  const isReEvaluationMode = !!initialData && !!isReEvaluation;

  const [patientInfo, setPatientInfo] = useState({
    cedula: '', name: '', age: '', gender: 'M', eps: '', symptoms: '', currentIllness: ''
  });

  const [vitals, setVitals] = useState<{
    heartRate: number | '';
    spo2: number | '';
    temperature: number | '';
    respiratoryRate: number | '';
    bloodPressureSys: number | '';
    bloodPressureDia: number | '';
    bloodPressureMap: number | '';
    painLevel: number;
  }>({
    heartRate: '', spo2: '', temperature: '', respiratoryRate: '',
    bloodPressureSys: '', bloodPressureDia: '', bloodPressureMap: '', painLevel: 0
  });

  const [bpInputText, setBpInputText] = useState('');


  const handleBpInputChange = (value: string) => {
    setBpInputText(value);
    
    if (!value.trim()) {
      setVitals(prev => ({
        ...prev,
        bloodPressureSys: '',
        bloodPressureDia: '',
        bloodPressureMap: ''
      }));
      return;
    }
    
    const parts = value.split('/');
    const cleanSys = parts[0] ? parts[0].trim() : '';
    const cleanDia = parts[1] ? parts[1].trim() : '';
    
    // Texto no numérico → '' (campo vacío, obligatorio), no 0: un 0 contaría como valor registrado.
    // Un "0" escrito (o el botón "signos vitales en 0") sí se conserva como 0.
    const toBp = (s: string): number | '' => { const n = parseInt(s); return isNaN(n) ? '' : n; };
    const sysNum = cleanSys !== '' ? toBp(cleanSys) : '';
    const diaNum = cleanDia !== '' ? toBp(cleanDia) : '';
    
    let mapVal: number | '' = '';
    if (typeof sysNum === 'number' && typeof diaNum === 'number' && sysNum > 0 && diaNum > 0) {
      mapVal = Math.round((sysNum + 2 * diaNum) / 3);
    }
    
    setVitals(prev => ({
      ...prev,
      bloodPressureSys: sysNum,
      bloodPressureDia: diaNum,
      bloodPressureMap: mapVal
    }));
  };

  const [glasgow, setGlasgow] = useState<GlasgowInput>(EMPTY_GLASGOW);

  // Campos obligatorios que faltan (misma regla que el servidor, src/shared/requiredFields.ts).
  // Un signo vital vacío cuenta igual si no se digitó o si el sensor IoT no entregó dato; una
  // subescala de Glasgow falta mientras el médico no elija un valor.
  const missingNarrative = missingNarrativeFields(patientInfo);
  const missingRequired = missingRequiredTriageFields({ ...patientInfo, vitals, glasgow });

  const [selectedSymptoms, setSelectedSymptoms]   = useState<string[]>([]);

  const [aiExtractedSymptoms, setAiExtractedSymptoms] = useState<string[]>([]);
  const [aiTriageResponse, setAiTriageResponse] = useState<{
    extractedSymptoms: string[];
    aiLevel: ESILevel;
    explanation: string;
    modifiersDetected: {
      gestante: boolean;
      adultoMayor: boolean;
      lactante: boolean;
      inmunosuprimido: boolean;
      oncologico: boolean;
    };
    _metrics?: { gemini_ms: number; modelUsed: string; modelsTried?: number; tokensIn?: number | null; tokensOut?: number | null };
  } | null>(null);
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);
  const [aiErrorMsg, setAiErrorMsg] = useState('');
  // Identifica el análisis vigente: al cambiar de paciente se incrementa y una respuesta en curso se descarta
  const aiRequestIdRef = useRef(0);

  // Descarta el análisis de IA y lo derivado de él. suggestedLevel, triageResult y finalLevel se
  // recalculan con el algoritmo en los efectos de abajo al quedar aiTriageResponse en null y
  // overrideReason vacío. Los síntomas y modificadores que puso la IA se limpian donde se llama.
  const resetAiState = () => {
    aiRequestIdRef.current++;
    setAiTriageResponse(null);
    setAiExtractedSymptoms([]);
    setAiErrorMsg('');
    setIsAiAnalyzing(false);
    setOverrideReason('');
  };

  const handleAnalyzeSymptomsWithAI = async () => {
    if (missingNarrative.length > 0) return; // El botón ya está deshabilitado; defensa adicional
    const requestId = ++aiRequestIdRef.current;
    setIsAiAnalyzing(true);
    setAiErrorMsg('');
    try {
      // El servidor valida los dos campos y arma el texto clínico ("motivo | enfermedad actual")
      const payload = {
        symptoms: patientInfo.symptoms,
        currentIllness: patientInfo.currentIllness,
        patientInfo: {
          age: parseInt(patientInfo.age) || 0,
          gender: patientInfo.gender,
          eps: patientInfo.eps
        },
        vitals: {
          heartRate: vitals.heartRate,
          spo2: vitals.spo2,
          temperature: vitals.temperature,
          respiratoryRate: vitals.respiratoryRate,
          sysBP: vitals.bloodPressureSys,
          diaBP: vitals.bloodPressureDia
        },
        gcsTotal: glasgow.total,
        hasShock,
        shockType,
        selectedModifiers
      };

      const res = await fetch('/api/triage/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || errData.details || errData.error || 'Error consultando al servidor para el análisis IA.');
      }

      const data = await res.json();
      // El paciente cambió mientras se analizaba: esta respuesta es de otro paciente y se descarta
      if (requestId !== aiRequestIdRef.current) return;

      setAiTriageResponse(data);
      setAiExtractedSymptoms(data.extractedSymptoms || []);
      
      if (data.modifiersDetected) {
        setSelectedModifiers(prev => ({
          ...prev,
          gestante: patientInfo.gender === 'F' ? (data.modifiersDetected.gestante ?? prev.gestante) : false,
          inmunosuprimido: data.modifiersDetected.inmunosuprimido ?? prev.inmunosuprimido,
          oncologico: data.modifiersDetected.oncologico ?? prev.oncologico
        }));
      }

      if (data.extractedSymptoms && Array.isArray(data.extractedSymptoms)) {
        setSelectedSymptoms(data.extractedSymptoms);
      }

      // Aplicar directamente el nivel de triage determinado por la IA de forma soberana
      if (data.aiLevel) {
        setSuggestedLevel(data.aiLevel);
        setFinalLevel(data.aiLevel);
        setTriageResult({
          level: data.aiLevel,
          reasons: [
            {
              factor: 'symptom',
              description: data.explanation || 'Clasificación asignada por IA Clínica según datos integrales del paciente',
              suggestedLevel: data.aiLevel
            }
          ],
          modifiersApplied: []
        });
        if (data.explanation) {
          setOverrideReason(`Clasificado por IA: ${data.explanation}`);
        }
      }

    } catch (err: any) {
      console.error(err);
      if (requestId === aiRequestIdRef.current) {
        setAiErrorMsg(err.message || 'Fallo indeterminado en el análisis con Inteligencia Artificial.');
      }
    } finally {
      if (requestId === aiRequestIdRef.current) setIsAiAnalyzing(false);
    }
  };

  const handleApplyAiTriage = () => {
    if (aiTriageResponse) {
      setFinalLevel(aiTriageResponse.aiLevel);
      if (aiTriageResponse.aiLevel !== suggestedLevel) {
        setOverrideReason(`Clasificado por IA: ${aiTriageResponse.explanation}`);
      }
    }
  };
  const [selectedModifiers, setSelectedModifiers] = useState({
    gestante: false,
    adultoMayor: false,
    lactante: false,
    inmunosuprimido: false,
    oncologico: false
  });

  useEffect(() => {
    const parsedAge = parseInt(patientInfo.age);
    if (!isNaN(parsedAge)) {
      setSelectedModifiers(prev => ({
        ...prev,
        adultoMayor: parsedAge > 65,
        lactante: parsedAge < 1 && parsedAge >= 0
      }));
    } else {
      setSelectedModifiers(prev => ({
        ...prev,
        adultoMayor: false,
        lactante: false
      }));
    }
  }, [patientInfo.age]);

  useEffect(() => {
    if (patientInfo.gender === 'M') {
      setSelectedModifiers(prev => ({
        ...prev,
        gestante: false
      }));
    }
  }, [patientInfo.gender]);

  const [hasShock, setHasShock]                   = useState(false);
  const [shockType, setShockType]                 = useState('');
  const [triageResult, setTriageResult]           = useState<TriageResult>({ level: ESILevel.FIVE, reasons: [], modifiersApplied: [] });
  const [suggestedLevel, setSuggestedLevel]       = useState<ESILevel>(ESILevel.FIVE);
  const [finalLevel, setFinalLevel]               = useState<ESILevel>(ESILevel.FIVE);
  const [overrideReason, setOverrideReason]       = useState('');
  const [correctionReason, setCorrectionReason]   = useState('');
  const [pendingPatients, setPendingPatients]     = useState<PendingPatient[]>([]);
  const [selectedPendingId, setSelectedPendingId] = useState<string | null>(null);
  const [status, setStatus]                       = useState<'IDLE' | 'MINING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [statusMsg, setStatusMsg]                 = useState('');
  const [bleController]                           = useState(() => new BluetoothDeviceController());
  const [isBleConnected, setIsBleConnected]       = useState(false);
  // Estado del ensayo de captura IoT (ver applyBleReading / applyBleDiagEvent)
  const [bleSensorState, setBleSensorState]       = useState<BleSensorState | null>(null);
  const bleSensorStateRef                         = useRef<BleSensorState | null>(null);
  // t_iot real: tiempo de CAPTURA_LISTA medido por el ESP32 desde el contacto del dedo
  const [bleAcquisitionSec, setBleAcquisitionSec] = useState<number | null>(null);
  // Cronómetro visible: arranca con el contacto del dedo y se detiene con ready = true
  const [bleCaptureStart, setBleCaptureStart]     = useState<number | null>(null);
  const [bleElapsedSec, setBleElapsedSec]         = useState<number | null>(null);
  const bleTrialRef                               = useRef<BleTrial>(newBleTrial());
  const bleSessionActiveRef                       = useRef(false);

  // Tema — sin cambios
  const t = isDarkMode ? {
    bg: 'bg-slate-950', card: 'bg-slate-900/50 border-slate-800/50',
    input: 'bg-slate-950/50 border-slate-800 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
    text: 'text-slate-200', heading: 'text-white', muted: 'text-slate-400',
    button: 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-600 hover:text-slate-200',
    buttonActive: 'bg-slate-700 text-white border-slate-500', divider: 'border-slate-800/50',
    iconBg: 'bg-slate-900/50', border: 'border-slate-800/50'
  } : {
    bg: 'bg-slate-50', card: 'bg-white border-slate-300 shadow-sm',
    input: 'bg-white border-slate-300 text-slate-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-400',
    text: 'text-slate-800 font-medium', heading: 'text-slate-950 font-bold', muted: 'text-slate-600 font-medium',
    button: 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-950 shadow-sm',
    buttonActive: 'bg-blue-50 text-blue-800 border-blue-400 font-bold', divider: 'border-slate-300',
    iconBg: 'bg-slate-100', border: 'border-slate-300'
  };

  useEffect(() => { loadPendingPatients(); }, []);

  const loadPendingPatients = async () => {
    try {
      const data = await dbService.getPendingPatients();
      setPendingPatients(data);
    } catch (error) { console.error("Error al cargar pacientes pendientes:", error); }
  };

  // Al seleccionar un paciente en espera se reinicia todo el bloque clínico: nada que el médico haya
  // llenado (o la IA o el sensor BLE hayan puesto) para el paciente anterior puede quedar en este.
  // Se conservan solo los datos demográficos que vienen de Admisión.
  const selectPendingPatient = (patient: PendingPatient) => {
    // Volver a pulsar el paciente ya seleccionado no borra lo que se lleva escrito
    if (patient.id === selectedPendingId) return;

    setPatientInfo({
      cedula: patient.cedula,
      name: patient.name,
      age: patient.age.toString(),
      gender: patient.gender,
      eps: patient.eps || '',
      symptoms: '',
      currentIllness: ''
    });
    setSelectedPendingId(patient.id);

    // El análisis de IA del paciente anterior no debe pasar a este: se descarta junto con los
    // síntomas y modificadores que la IA había puesto. adultoMayor/lactante se recalculan con la
    // edad del nuevo paciente (el efecto de edad no corre si la edad no cambia).
    resetAiState();
    setSelectedSymptoms([]);
    setSelectedModifiers({
      gestante: false,
      adultoMayor: patient.age > 65,
      lactante: patient.age < 1 && patient.age >= 0,
      inmunosuprimido: false,
      oncologico: false
    });

    // Datos clínicos que el médico llena a mano (todos entran en buildHashPayload)
    setVitals({
      heartRate: '', spo2: '', temperature: '', respiratoryRate: '',
      bloodPressureSys: '', bloodPressureDia: '', bloodPressureMap: '', painLevel: 0
    });
    setBpInputText('');
    setGlasgow(EMPTY_GLASGOW);
    setHasShock(false);
    setShockType('');
    setCorrectionReason('');
    // finalLevel lo vuelve a igualar al nivel sugerido el efecto que depende de selectedPendingId

    // Sesión BLE: se cierra para que ni las lecturas en curso ni el t_iot del paciente anterior
    // se asignen a este. disconnect() anula los callbacks, así que no salta el aviso de desconexión.
    bleController.disconnect();
    resetBleSession();
    setBleAcquisitionSec(null);

    // Un error de guardado del paciente anterior no aplica a este
    setStatus('IDLE');
    setStatusMsg('');
  };

  const handleSetAllVitalsToZero = () => {
    const isAlreadyZero = vitals.heartRate === 0 && vitals.bloodPressureSys === 0 && vitals.spo2 === 0;
    if (isAlreadyZero) {
      setVitals({
        heartRate: '',
        spo2: '',
        temperature: '',
        respiratoryRate: '',
        bloodPressureSys: '',
        bloodPressureDia: '',
        bloodPressureMap: '',
        painLevel: 0
      });
      setBpInputText('');
    } else {
      setVitals({
        heartRate: 0,
        spo2: 0,
        temperature: 0,
        respiratoryRate: 0,
        bloodPressureSys: 0,
        bloodPressureDia: 0,
        bloodPressureMap: 0,
        painLevel: 0
      });
      setBpInputText('0/0');
    }
  };


  // Sync blood pressure text input from vitals is handled during initialData load,
  // selectPendingPatient, and when manual updates occur, allowing clean manual typing.

  useEffect(() => {
    if (initialData) {
      const d = initialData.patientData;
      // Una corrección o re-evaluación empieza sin análisis de IA propio (aiLevel null si no se
      // vuelve a analizar). En corrección, overrideReason se recarga del registro más abajo.
      resetAiState();
      setPatientInfo({
        cedula: d.cedula,
        name: d.name,
        age: d.age.toString(),
        gender: d.gender,
        eps: d.eps || '',
        symptoms: isReEvaluation ? '' : d.symptoms,
        currentIllness: isReEvaluation ? '' : (d.currentIllness || '')
      });
      if (isReEvaluation) {
        setVitals({
          heartRate: '', spo2: '', temperature: '', respiratoryRate: '',
          bloodPressureSys: '', bloodPressureDia: '', bloodPressureMap: '', painLevel: 0
        });
        setBpInputText('');
        // Re-evaluación = nueva valoración: el Glasgow se vuelve a evaluar (obligatorio), como los signos vitales
        setGlasgow(EMPTY_GLASGOW);
        setSelectedSymptoms([]);
        setHasShock(false);
        setShockType('');
        setSelectedModifiers({
          gestante: false,
          adultoMayor: false,
          lactante: false,
          inmunosuprimido: false,
          oncologico: false
        });
        setOverrideReason('');
      } else {
        if (d.vitals) {
          setVitals({
            heartRate: d.vitals.heartRate ?? '',
            spo2: d.vitals.spo2 ?? '',
            temperature: d.vitals.temperature ?? '',
            respiratoryRate: d.vitals.respiratoryRate ?? '',
            bloodPressureSys: d.vitals.bloodPressureSys ?? '',
            bloodPressureDia: d.vitals.bloodPressureDia ?? '',
            bloodPressureMap: d.vitals.bloodPressureMap ?? '',
            painLevel: d.vitals.painLevel ?? 0
          });
        }
        if (d.vitals && (d.vitals.bloodPressureSys || d.vitals.bloodPressureDia)) {
          setBpInputText(`${d.vitals.bloodPressureSys || ''}/${d.vitals.bloodPressureDia || ''}`);
        }
        if (d.glasgow) setGlasgow(d.glasgow);
        if (d.selectedSymptoms) {
          setSelectedSymptoms(d.selectedSymptoms.filter(s => !s.startsWith('Shock') && !s.startsWith('Modifier')));
          const shockSym = d.selectedSymptoms.find(s => s.startsWith('Shock'));
          if (shockSym) { setHasShock(true); setShockType(shockSym.replace('Shock ', '').replace(' (Sin tipificar)', '')); }
          setSelectedModifiers({
            gestante: d.selectedSymptoms.includes('Modifier: Gestante'),
            adultoMayor: d.selectedSymptoms.includes('Modifier: Adulto mayor > 65 años'),
            lactante: d.selectedSymptoms.includes('Modifier: Lactante < 1 año'),
            inmunosuprimido: d.selectedSymptoms.includes('Modifier: Inmunosuprimido'),
            oncologico: d.selectedSymptoms.includes('Modifier: Paciente oncológico')
          });
        }
        if (d.overrideReason) setOverrideReason(d.overrideReason);
      }
    }
  }, [initialData, isReEvaluation]);

  useEffect(() => {
    setGlasgow(prev => ({
      ...prev,
      total: prev.eyeOpening !== null && prev.verbalResponse !== null && prev.motorResponse !== null
        ? prev.eyeOpening + prev.verbalResponse + prev.motorResponse
        : null
    }));
  }, [glasgow.eyeOpening, glasgow.verbalResponse, glasgow.motorResponse]);

  // ── Recalcular triage al cambiar cualquier variable clínica ──
  useEffect(() => {
    // Si la IA ya determinó el nivel clínico, se mantiene la clasificación de la IA
    if (aiTriageResponse?.aiLevel) {
      setSuggestedLevel(aiTriageResponse.aiLevel);
      return;
    }

    const allSymptoms = [...selectedSymptoms];
    if (hasShock) allSymptoms.push(shockType ? `Shock ${shockType}` : 'Shock (Sin tipificar)');

    const result = calcularTriage(
      // Glasgow incompleto → 15 (no aporta criterio), como antes con el valor por defecto. No se usa
      // null: "null <= 8" es verdadero y daría Triage I. No se puede guardar sin Glasgow completo,
      // así que el nivel sugerido que se guarda siempre usa el Glasgow real.
      glasgow.total ?? 15,
      Number(vitals.respiratoryRate) || 0,
      Number(vitals.heartRate) || 0,
      Number(vitals.bloodPressureSys) || 0,
      Number(vitals.spo2) || 0,
      Number(vitals.temperature) || 0,
      allSymptoms,
      selectedModifiers
    );
    setTriageResult(result);
    setSuggestedLevel(result.level);
  }, [glasgow.total, vitals, selectedSymptoms, hasShock, shockType, patientInfo.age, patientInfo.gender, selectedModifiers, aiTriageResponse]);

  useEffect(() => {
    if (!overrideReason && !isCorrectionMode) setFinalLevel(suggestedLevel);
    // selectedPendingId: al cambiar de paciente, un nivel final elegido a mano para el anterior se
    // descarta aunque el nivel sugerido del nuevo paciente coincida con el del anterior
  }, [suggestedLevel, isCorrectionMode, overrideReason, selectedPendingId]);

  // Al desmontar el formulario (guardar, cambiar de vista) se cierra la conexión GATT si sigue
  // abierta. disconnect() anula los callbacks antes de cerrar: no hay aviso ni setState tras desmontar.
  useEffect(() => {
    return () => bleController.disconnect();
  }, [bleController]);

  // Cronómetro visible mientras el ensayo no termina (se congela en incompleto / timeout)
  useEffect(() => {
    if (bleCaptureStart === null || (bleSensorState !== 'midiendo' && bleSensorState !== 'senal_deficiente')) return;
    const id = setInterval(() => setBleElapsedSec((performance.now() - bleCaptureStart) / 1000), 100);
    return () => clearInterval(id);
  }, [bleCaptureStart, bleSensorState]);

  const setBleState = (state: BleSensorState | null) => {
    bleSensorStateRef.current = state;
    setBleSensorState(state);
  };

  const resetBleSession = () => {
    bleSessionActiveRef.current = false;
    bleTrialRef.current = newBleTrial();
    setIsBleConnected(false);
    setBleState(null);
    setBleCaptureStart(null);
    setBleElapsedSec(null);
  };

  // Contacto del dedo: nuevo ensayo y arranque del cronómetro de captura. Lo disparan el evento
  // CONTACTO del ESP32 (force) o el primer paquete con dedo tras haber visto "sin dedo".
  const startBleTrial = (force: boolean) => {
    const trial = bleTrialRef.current;
    if (trial.fingerOn && !force) return;
    const contactSeen = force || trial.sawFingerOff;
    const startedAt = contactSeen ? performance.now() - FINGER_CONFIRM_MS : null;
    Object.assign(trial, { fingerOn: true, contactSeen, startedAt, captured: false, firmwareTime: false });
    setBleCaptureStart(startedAt);
    setBleElapsedSec(contactSeen ? FINGER_CONFIRM_MS / 1000 : null);
    setBleState('midiendo');
  };

  // Aplica un paquete del ESP32. Los signos vitales solo se llenan con ready = true
  // (CAPTURA_LISTA): los valores previos a la estabilización no llegan al formulario.
  const applyBleReading = (d: IoTData) => {
    const trial = bleTrialRef.current;
    const current = bleSensorStateRef.current;

    if (!d.finger) {
      trial.fingerOn = false;
      trial.sawFingerOff = true;
      if (current === 'midiendo' || current === 'senal_deficiente') setBleState('incompleto');
      else if (current === null || current === 'esperando_dedo') setBleState('esperando_dedo');
      // estable / incompleto / timeout se conservan hasta el siguiente contacto
      return;
    }

    startBleTrial(false);   // Sin efecto si el contacto ya estaba registrado

    if (d.ready) {
      if (trial.captured) return;
      trial.captured = true;

      // Respaldo si la notificación CAPTURA_LISTA no llegó: reloj de la app desde el contacto.
      // Si la sesión empezó con el dedo ya puesto, el contacto no se observó y no hay t_iot.
      if (!trial.firmwareTime && trial.contactSeen && trial.startedAt !== null) {
        const sec = Number(((performance.now() - trial.startedAt) / 1000).toFixed(2));
        setBleAcquisitionSec(sec);
        setBleElapsedSec(sec);
      }

      console.log(`[ESP32] Captura: FC ${d.heartRate} lpm, SpO2 ${d.spo2} %, Temp ${d.temperature} °C`);

      setVitals(prev => {
        // Con ready el ESP32 ya filtró la temperatura (lectura cruda >= 33 °C, estable 3 s,
        // + CAL_B): llega desde 34.5 °C. Solo se descarta un valor nulo o mayor a 43 °C.
        const validTemp = d.temperature > 0 && d.temperature <= 43.0;
        return {
          ...prev,
          heartRate: d.heartRate > 0 ? d.heartRate : prev.heartRate,
          spo2: d.spo2 > 0 ? d.spo2 : prev.spo2,
          temperature: validTemp ? d.temperature : prev.temperature
        };
      });
      setBleState('estable');
      return;
    }

    // Tras TIMEOUT el ESP32 sigue enviando datos hasta que se retira el dedo
    if (bleSensorStateRef.current === 'timeout') return;
    setBleState(d.quality === 'poor_signal' ? 'senal_deficiente' : 'midiendo');
  };

  // Evento de la característica de diagnóstico ("ensayo,código,tiempo_ms" medido por el ESP32)
  const applyBleDiagEvent = (ev: IoTDiagEvent) => {
    const trial = bleTrialRef.current;

    switch (ev.code) {
      case 'C':
        startBleTrial(true);
        break;
      case 'L': {
        // t_iot oficial: CAPTURA_LISTA, en ms desde el contacto del dedo
        const sec = Number((ev.elapsedMs / 1000).toFixed(2));
        trial.firmwareTime = true;
        setBleAcquisitionSec(sec);
        setBleElapsedSec(sec);
        break;
      }
      case 'INC':
        trial.fingerOn = false;
        trial.sawFingerOff = true;
        setBleState('incompleto');
        break;
      case 'TO':
        setBleState('timeout');
        break;
      case 'R':
        trial.fingerOn = false;
        trial.sawFingerOff = true;
        break;
    }
  };


  const handleIoTConnect = async () => {
    if (isBleConnected) {
      bleController.disconnect();
      resetBleSession();
      return;
    }

    setIsScanning(true);
    setBleAcquisitionSec(null);
    try {
      const deviceGranted = await bleController.requestDevice();
      if (deviceGranted) {
        // El cronómetro de t_iot no arranca aquí sino con el contacto del dedo (startBleTrial)
        const data = await bleController.connect(applyBleReading, () => {
          // Desconexión no solicitada (ESP32 apagado o fuera de rango). Si ocurre durante
          // el intento de conexión, el catch de abajo ya informa la falla: no se duplica el aviso.
          const wasActive = bleSessionActiveRef.current;
          resetBleSession();
          if (wasActive) {
            alert("⚠️ Se perdió la conexión con el sensor IoT (ESP32). Los valores ya capturados se conservan; verifique el equipo o continúe con captura manual.");
          }
        }, applyBleDiagEvent);
        bleSessionActiveRef.current = true;
        setIsBleConnected(true);
        if (data) applyBleReading(data);
      } else {
        // RF-03: navegador sin soporte Web Bluetooth o selector de dispositivo cancelado.
        // No se precarga ningún dato simulado: el médico completa los signos vitales manualmente.
        resetBleSession();
        alert("⚠️ No se pudo iniciar la conexión con el sensor IoT (ESP32). Por favor, ingrese los signos vitales manualmente.");
      }
    } catch (e) {
      // RF-03: falló la conexión GATT o hubo timeout sin datos del sensor. No se sustituye con
      // valores simulados: se cierra la conexión GATT (si quedó abierta) y se deja el formulario
      // en captura manual, igual que si nunca se hubiera intentado la conexión BLE.
      console.error('Error BLE:', e);
      bleController.disconnect();
      resetBleSession();
      alert("⚠️ La conexión automática con el sensor IoT (ESP32) falló. Por favor, ingrese los signos vitales manualmente.");
    } finally {
      setIsScanning(false);
    }
  };

  const handleSubmit = async () => {
    // El botón ya está deshabilitado y la lista de faltantes visible; defensa adicional
    if (missingRequired.length > 0) return;
    if (suggestedLevel !== finalLevel && !overrideReason.trim()) {
      alert("⚠️ REQUERIDO: Debe justificar por qué cambió el nivel sugerido por el sistema.");
      return;
    }
    if (isCorrectionMode && !correctionReason.trim()) {
      alert("⚠️ REQUERIDO: Para corregir un registro existente, debe explicar la razón del cambio.");
      return;
    }
    if (isReEvaluationMode && !correctionReason.trim()) {
      alert("⚠️ REQUERIDO: Para registrar una re-evaluación, debe documentar el motivo clínico o cambio de estado.");
      return;
    }

    const recordId = crypto.randomUUID();
    const finalSymptoms = [...selectedSymptoms];
    if (hasShock) finalSymptoms.push(shockType ? `Shock ${shockType}` : 'Shock (Sin tipificar)');
    if (selectedModifiers.gestante) finalSymptoms.push('Modifier: Gestante');
    if (selectedModifiers.adultoMayor) finalSymptoms.push('Modifier: Adulto mayor > 65 años');
    if (selectedModifiers.lactante) finalSymptoms.push('Modifier: Lactante < 1 año');
    if (selectedModifiers.inmunosuprimido) finalSymptoms.push('Modifier: Inmunosuprimido');
    if (selectedModifiers.oncologico) finalSymptoms.push('Modifier: Paciente oncológico');

    // Glasgow ya validado (missingRequired vacío): las tres subescalas tienen valor. El total se
    // recalcula aquí para no depender de que el efecto que lo actualiza ya haya corrido.
    const glasgowScale: GlasgowScale = {
      eyeOpening: glasgow.eyeOpening!,
      verbalResponse: glasgow.verbalResponse!,
      motorResponse: glasgow.motorResponse!,
      total: glasgow.eyeOpening! + glasgow.verbalResponse! + glasgow.motorResponse!,
    };

    const cleanVitals: VitalSigns = {
      heartRate: vitals.heartRate !== '' ? Number(vitals.heartRate) : 0,
      spo2: vitals.spo2 !== '' ? Number(vitals.spo2) : 0,
      temperature: vitals.temperature !== '' ? Number(vitals.temperature) : 0,
      respiratoryRate: vitals.respiratoryRate !== '' ? Number(vitals.respiratoryRate) : 0,
      bloodPressureSys: vitals.bloodPressureSys !== '' ? Number(vitals.bloodPressureSys) : 0,
      bloodPressureDia: vitals.bloodPressureDia !== '' ? Number(vitals.bloodPressureDia) : 0,
      bloodPressureMap: vitals.bloodPressureMap !== '' ? Number(vitals.bloodPressureMap) : 0,
      painLevel: Number(vitals.painLevel) || 0,
    };

    const newPatientData: PatientData = {
      id: recordId,
      cedula: patientInfo.cedula,
      name: patientInfo.name,
      age: parseInt(patientInfo.age) || 0,
      gender: patientInfo.gender as 'M' | 'F' | 'O',
      eps: patientInfo.eps,
      symptoms: patientInfo.symptoms,
      currentIllness: patientInfo.currentIllness,
      vitals: cleanVitals,
      glasgow: glasgowScale,
      checklist: {} as any,
      selectedSymptoms: finalSymptoms,
      suggestedEsiLevel: suggestedLevel,
      finalEsiLevel: finalLevel,
      aiLevel: aiTriageResponse?.aiLevel ?? null,
      aiModelUsed: aiTriageResponse?._metrics?.modelUsed ?? null,
      overrideReason: overrideReason || "Concordancia con Algoritmo",
      triageTimestamp: Date.now(),
      estimatedAttentionTime: addMinutes(new Date(), getAttentionTime(finalLevel)).getTime(),
      doctorId: walletAddress,
      parentRecordHash: initialData ? initialData.blockchainHash : undefined,
      correctionReason: (isCorrectionMode || isReEvaluationMode) ? correctionReason : undefined,
    };

    try {
      const t0_db = performance.now();

      // El servidor calcula el hash, lo firma con el Relayer, lo ancla en Polygon y guarda en MongoDB
      setStatus('MINING');
      setStatusMsg("Guardando de forma segura en el expediente clínico...");
      const savedRec: any = await dbService.insertRecordInvisible(newPatientData, walletAddress);
      const dbMetrics: any = savedRec?._metrics;

      const t1_db = performance.now();
      const realDbTimeSec = dbMetrics?.t_db_ms ? Number((dbMetrics.t_db_ms / 1000).toFixed(3)) : Number(((t1_db - t0_db) / 1000).toFixed(3));
      // Sin métrica real (p. ej. no se ejecutó el análisis IA o el relayer no reportó tiempos) → null,
      // nunca un valor fijo. Las estadísticas excluyen los null de su fase.
      const realBcTimeSec = dbMetrics?.t_bc_ms ? Number((dbMetrics.t_bc_ms / 1000).toFixed(2)) : null;
      const realAiTimeSec = (aiTriageResponse as any)?._metrics?.gemini_ms ? Number(((aiTriageResponse as any)._metrics.gemini_ms / 1000).toFixed(2)) : null;

      const isBleActive = isBleConnected;
      // t_iot medido en la sesión BLE; null si no hubo lectura válida (no se usa un valor fijo)
      const iotTimeVal = isBleActive ? bleAcquisitionSec : null;
      // t_ui: tiempo real que espera el médico al guardar, medido en el cliente desde t0_db (inicio del
      // guardado: POST al servidor) hasta t1_db (respuesta del servidor con el registro ya anclado en
      // Polygon y guardado en MongoDB). No es una suma de fases.
      const totalUiRoundtripSec = Number(((t1_db - t0_db) / 1000).toFixed(2));

      // Guardar telemetría real en MongoDB y LocalStorage
      const telemetryResult = await telemetryService.saveLog({
        patientName: patientInfo.name || 'Paciente Triage',
        t_iot: iotTimeVal,
        isBleConnected: isBleActive,
        t_ai: realAiTimeSec,
        t_db_hash: realDbTimeSec,
        t_ui: totalUiRoundtripSec,
        t_blockchain: realBcTimeSec,
        // Tiempos criptográficos del servidor en ms (typeof conserva un 0 legítimo; ausente → null)
        t_hash_ms: typeof dbMetrics?.t_hash_ms === 'number' ? dbMetrics.t_hash_ms : null,
        t_firma_ms: typeof dbMetrics?.t_firma_ms === 'number' ? dbMetrics.t_firma_ms : null,
        // Costos: gas y precio del recibo de la transacción; tokens y modelos probados del análisis IA
        // de este triage (null si no se ejecutó). Ausente → null, sin valores de relleno
        gas_used: typeof dbMetrics?.gasUsed === 'string' ? Number(dbMetrics.gasUsed) : null,
        effective_gas_price_wei: typeof dbMetrics?.effectiveGasPrice === 'string' ? dbMetrics.effectiveGasPrice : null,
        cost_pol: typeof dbMetrics?.costPol === 'string' ? dbMetrics.costPol : null,
        ai_tokens_in: aiTriageResponse?._metrics?.tokensIn ?? null,
        ai_tokens_out: aiTriageResponse?._metrics?.tokensOut ?? null,
        ai_models_tried: aiTriageResponse?._metrics?.modelsTried ?? null,
        isRealMeasurement: true
      });
      // El registro clínico ya quedó guardado; solo falló la telemetría. Se avisa sin abortar el flujo.
      if (!telemetryResult.persisted) {
        alert(`⚠️ El triage se guardó correctamente, pero la medición de telemetría NO se registró en MongoDB (${telemetryResult.error}). Quedó solo en la caché local de este navegador.`);
      }

      if (selectedPendingId) {
        try { await dbService.removePendingPatient(selectedPendingId); }
        catch (removeErr) { console.warn("No se pudo remover al paciente de la lista de espera."); }
      }

      setStatus('SUCCESS');
      setStatusMsg("Registro Completado.");
      setTimeout(() => { setStatus('IDLE'); if (onSuccess) onSuccess(); }, 2000);
    } catch (error: any) {
      console.error(error);
      setStatus('ERROR');
      setStatusMsg(error.message || "Error Crítico");
    }
  };

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div className={`${t.bg} ${t.text} min-h-screen p-4 md:p-8 font-sans transition-colors duration-300`}>
      <div className="max-w-4xl mx-auto space-y-6">

        {/* HEADER */}
        <div className={`flex justify-between items-center pb-4 border-b ${t.divider}`}>
          <h1 className={`${t.heading} text-2xl font-bold tracking-tight flex items-center gap-2`}>
            <Activity className="w-6 h-6 text-blue-500" />
            Registro de Triage
          </h1>
          <button onClick={() => setIsDarkMode(!isDarkMode)} className={`p-2 rounded-full border transition-all ${t.button}`}
            title={isDarkMode ? "Cambiar a Modo Claro" : "Cambiar a Modo Oscuro"} type="button">
            {isDarkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
          </button>
        </div>

        {/* PACIENTES EN ESPERA */}
        {/* Oculta también en re-evaluación: si no, el paciente elegido heredaría el parentRecordHash del registro re-evaluado */}
        {!initialData && pendingPatients.length > 0 && (
          <section className={`${t.card} rounded-xl p-5 border shadow-sm border-indigo-500/30 bg-indigo-500/5`}>
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-5 h-5 text-indigo-500" />
              <h2 className={`${t.heading} text-sm font-bold uppercase tracking-wider opacity-80`}>Pacientes en Espera (Admisión)</h2>
            </div>
            <div className="flex overflow-x-auto gap-3 pb-2 scrollbar-none">
              {pendingPatients.map(p => (
                <button key={p.id} onClick={() => selectPendingPatient(p)}
                  // No se cambia de paciente mientras se guarda o se conecta el sensor BLE
                  disabled={status === 'MINING' || status === 'SUCCESS' || isScanning}
                  className={`flex-shrink-0 text-left p-3 rounded-xl border transition-all min-w-[200px] disabled:opacity-50 disabled:cursor-not-allowed ${
                    selectedPendingId === p.id ? 'bg-indigo-600 border-indigo-400 text-white shadow-lg' : `${t.iconBg} ${t.border} ${t.text} hover:border-indigo-400`
                  }`} type="button">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-bold text-sm block truncate">{p.name}</span>
                    {selectedPendingId === p.id && <CheckCircle className="w-4 h-4" />}
                  </div>
                  <div className={`text-[10px] ${selectedPendingId === p.id ? 'text-indigo-100' : t.muted} font-medium flex flex-col gap-0.5 mt-0.5`}>
                    <div>ID: {p.cedula} • {p.age} años</div>
                    {p.eps && <div className={`${selectedPendingId === p.id ? 'text-white font-bold' : 'text-blue-400 font-semibold'}`}>EPS: {p.eps}</div>}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {isCorrectionMode && (
          <div className="bg-amber-900/20 border border-amber-500/30 p-4 rounded-xl flex items-center gap-3">
            <FileWarning className="w-6 h-6 text-amber-500" />
            <div>
              <h2 className="font-bold text-amber-500 text-sm">Modo de Anexo de Información</h2>
              <p className="text-xs text-amber-200/70">Está anexando información a un registro existente. Se generará un nuevo bloque enlazado al anterior.</p>
            </div>
          </div>
        )}

        {isReEvaluationMode && (
          <div className="bg-blue-900/20 border border-blue-500/30 p-4 rounded-xl flex items-center gap-3">
            <HeartPulse className="w-6 h-6 text-blue-500" />
            <div>
              <h2 className="font-bold text-blue-500 text-sm">Modo de Re-evaluación Clínica (Re-Triage)</h2>
              <p className="text-xs text-blue-200/70">Está realizando una re-evaluación por cambio en el estado del paciente. Se calculará un nuevo nivel ESI y se generará un nuevo bloque enlazado al historial anterior.</p>
            </div>
          </div>
        )}

        {/* 1. DATOS DEL PACIENTE */}
        <section className={`${t.card} rounded-xl p-5 border shadow-sm`}>
          <div className="flex justify-between items-center mb-4">
            <h2 className={`${t.heading} text-sm font-bold uppercase tracking-wider opacity-80`}>1. Datos del Paciente</h2>
            {selectedPendingId && (
              <span className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-3 py-1 rounded-full font-semibold border border-emerald-500/20 animate-fade-in flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" />
                Importado de Admisión
              </span>
            )}
          </div>

          {!selectedPendingId && !isCorrectionMode && (
            <div className="mb-4 p-3 bg-blue-500/5 border border-blue-500/20 text-blue-600 dark:text-blue-400 rounded-xl text-xs flex items-center gap-2">
              <span className="font-bold flex-shrink-0 bg-blue-500 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px]">!</span>
              <span>Por favor, seleccione un paciente de la lista anterior para auto-completar los datos demográficos (Cédula, Nombre, Edad, Sexo, EPS) registrados en Admisiones.</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div className="space-y-1">
              <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider`}>Cédula / ID</label>
              <input 
                className={`w-full rounded-lg px-3 py-2 text-sm transition-all ${t.input} ${selectedPendingId ? 'opacity-70 bg-slate-100/50 dark:bg-slate-800/50 cursor-not-allowed' : ''}`} 
                placeholder="123456789"
                value={patientInfo.cedula} 
                onChange={e => setPatientInfo({ ...patientInfo, cedula: e.target.value })} 
                disabled={!!selectedPendingId || isCorrectionMode} 
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider`}>Nombre Completo</label>
              <input 
                className={`w-full rounded-lg px-3 py-2 text-sm transition-all ${t.input} ${selectedPendingId ? 'opacity-70 bg-slate-100/50 dark:bg-slate-800/50 cursor-not-allowed' : ''}`} 
                placeholder="Juan Pérez"
                value={patientInfo.name} 
                onChange={e => setPatientInfo({ ...patientInfo, name: e.target.value })} 
                disabled={!!selectedPendingId || isCorrectionMode} 
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider`}>Edad</label>
                <input 
                  type="number" 
                  className={`w-full rounded-lg px-3 py-2 text-sm transition-all ${t.input} ${selectedPendingId ? 'opacity-70 bg-slate-100/50 dark:bg-slate-800/50 cursor-not-allowed' : ''}`} 
                  placeholder="Años"
                  value={patientInfo.age} 
                  onChange={e => setPatientInfo({ ...patientInfo, age: e.target.value })} 
                  disabled={!!selectedPendingId || isCorrectionMode}
                />
              </div>
              <div className="space-y-1">
                <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider`}>Sexo</label>
                <select 
                  className={`w-full rounded-lg px-3 py-2 text-sm transition-all ${t.input} ${selectedPendingId ? 'opacity-70 bg-slate-100/50 dark:bg-slate-800/50 cursor-not-allowed' : ''}`}
                  value={patientInfo.gender} 
                  onChange={e => setPatientInfo({ ...patientInfo, gender: e.target.value })}
                  disabled={!!selectedPendingId || isCorrectionMode}
                >
                  <option value="M">Masculino</option>
                  <option value="F">Femenino</option>
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider`}>EPS / Aseguradora</label>
              <input 
                className={`w-full rounded-lg px-3 py-2 text-sm transition-all ${t.input} ${selectedPendingId ? 'opacity-70 bg-slate-100/50 dark:bg-slate-800/50 cursor-not-allowed' : ''}`} 
                placeholder="Ej: SURA, Sanitas..."
                value={patientInfo.eps} 
                onChange={e => setPatientInfo({ ...patientInfo, eps: e.target.value })} 
                disabled={!!selectedPendingId || isCorrectionMode}
              />
            </div>
            <div className="col-span-1 md:col-span-5 space-y-1">
              <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider`}>Motivo de Consulta</label>
              <textarea rows={2} className={`w-full rounded-lg px-3 py-2 text-sm transition-all resize-none ${t.input}`}
                placeholder="Ej: Me duele mucho el pecho..." value={patientInfo.symptoms}
                onChange={e => setPatientInfo({ ...patientInfo, symptoms: e.target.value })} />
            </div>
            <div className="col-span-1 md:col-span-5 space-y-1">
              <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider`}>Enfermedad Actual</label>
              <textarea rows={3} className={`w-full rounded-lg px-3 py-2 text-sm transition-all resize-none ${t.input}`}
                placeholder="Paciente de X años que ingresa por cuadro clínico de..." value={patientInfo.currentIllness}
                onChange={e => setPatientInfo({ ...patientInfo, currentIllness: e.target.value })} />
            </div>
          </div>
        </section>

        {/* 2. SIGNOS VITALES */}
        <section className={`${t.card} rounded-xl p-5 border shadow-sm`}>
          <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
            <h2 className={`${t.heading} text-sm font-bold uppercase tracking-wider opacity-80`}>2. Signos Vitales</h2>
            <div className="flex gap-2 items-center flex-wrap">
              {isBleConnected && bleSensorState === 'esperando_dedo' && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                  <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
                  Esperando dedo · colóquelo en el sensor
                </span>
              )}
              {isBleConnected && bleSensorState === 'midiendo' && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Midiendo…{bleElapsedSec !== null && ` ${bleElapsedSec.toFixed(1)} s`}
                </span>
              )}
              {isBleConnected && bleSensorState === 'senal_deficiente' && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/30">
                  <AlertTriangle className="w-3 h-3" />
                  Señal deficiente · mantenga el dedo quieto{bleElapsedSec !== null && ` (${bleElapsedSec.toFixed(1)} s)`}
                </span>
              )}
              {isBleConnected && bleSensorState === 'estable' && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                  <CheckCircle className="w-3 h-3" />
                  Captura estable{bleAcquisitionSec !== null && ` · ${bleAcquisitionSec.toFixed(2)} s`}
                </span>
              )}
              {isBleConnected && bleSensorState === 'incompleto' && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/30">
                  <FileWarning className="w-3 h-3" />
                  Incompleto · dedo retirado antes de estabilizar
                </span>
              )}
              {isBleConnected && bleSensorState === 'timeout' && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/30">
                  <AlertTriangle className="w-3 h-3" />
                  Timeout (60 s) sin estabilizar · retire y vuelva a colocar el dedo
                </span>
              )}
              <button
                onClick={handleSetAllVitalsToZero}
                className="flex items-center gap-1.5 bg-red-500/10 text-red-500 border border-red-500/20 px-3 py-1.5 rounded-md text-xs font-bold hover:bg-red-500/20 transition-colors" 
                type="button"
              >
                🚨 {(vitals.heartRate === 0 && vitals.bloodPressureSys === 0) ? 'Restablecer Vacíos' : 'Sin Signos Vitales'}
              </button>
              <button onClick={handleIoTConnect} disabled={isScanning}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all border ${
                  isBleConnected 
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/25' 
                    : 'bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/20'
                }`} 
                type="button">
                {isScanning ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Bluetooth className="w-3.5 h-3.5" />
                )}
                {isScanning ? 'Buscando ESP32...' : isBleConnected ? 'ESP32 Conectado · Desconectar' : 'Sensor IoT (BLE)'}
              </button>
            </div>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* 4 General Vitals */}
            <div className="lg:col-span-8 grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: 'Frec. Cardíaca', unit: 'lpm', key: 'heartRate', step: 1 },
                { label: 'SpO₂', unit: '%', key: 'spo2', step: 1 },
                { label: 'Temperatura', unit: '°C', key: 'temperature', step: 0.1 },
                { label: 'Frec. Resp.', unit: 'rpm', key: 'respiratoryRate', step: 1 },
              ].map(({ label, unit, key, step }) => (
                <div key={key} className={`${t.iconBg} p-3 rounded-xl border ${t.border}`}>
                  <label className={`text-[10px] font-bold ${t.muted} uppercase`}>{label}</label>
                  <div className="flex items-baseline gap-1">
                    <input type="number" step={step}
                      className={`w-full bg-transparent text-xl font-black ${t.heading} mt-1 focus:outline-none`}
                      value={(vitals as any)[key] ?? ''} placeholder="-"
                      onChange={e => {
                        const val = e.target.value;
                        let parsed: number | '' = '';
                        if (val !== '') {
                          const num = step === 1 ? parseInt(val) : parseFloat(val);
                          parsed = isNaN(num) ? '' : num;
                        }
                        setVitals({ ...vitals, [key]: parsed });
                      }} />
                    <span className={`text-[10px] ${t.muted}`}>{unit}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Blood Pressure Unified Block */}
            <div className="lg:col-span-4 p-3 rounded-xl border border-blue-500/15 bg-blue-500/5 dark:bg-blue-950/10 flex flex-col justify-between">
              <div>
                <label className="text-[10px] font-extrabold text-blue-500 dark:text-blue-400 uppercase tracking-widest block mb-1.5">
                  Presión Arterial (PA) & PAM
                </label>
                <div className="grid grid-cols-2 gap-2 items-center">
                  {/* Presion Sistolica / Diastolica juntas */}
                  <div className="bg-white/40 dark:bg-slate-900/40 p-2 rounded-lg border border-slate-200/60 dark:border-slate-800/60">
                    <label className={`text-[9px] font-bold ${t.muted} uppercase block mb-1`}>P. Arterial (S/D)</label>
                    <div className="flex items-baseline gap-1">
                      <input type="text"
                        className={`w-full bg-transparent text-sm font-black ${t.heading} focus:outline-none`}
                        value={bpInputText} placeholder="Ej: 120/80"
                        onChange={e => handleBpInputChange(e.target.value)} />
                      <span className="text-[8px] text-slate-400 dark:text-slate-500 font-mono">mmHg</span>
                    </div>
                  </div>

                  {/* PAM Auto */}
                  <div className="bg-blue-50 dark:bg-blue-950/30 p-2 rounded-lg border border-blue-200/60 dark:border-blue-900/40">
                    <label className="text-[9px] font-bold text-blue-600 dark:text-blue-400 uppercase block mb-1 flex items-center justify-between font-mono">
                      <span>PAM</span>
                      <span className="text-[8px] bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 px-1 rounded-sm scale-90">Auto</span>
                    </label>
                    <div className="flex items-baseline gap-0.5">
                      <input type="number" step={1}
                        className="w-full bg-transparent text-base font-black text-blue-700 dark:text-blue-400 focus:outline-none"
                        value={vitals.bloodPressureMap || ''} placeholder="Auto"
                        onChange={e => {
                          const val = parseInt(e.target.value) || '';
                          setVitals(prev => ({
                            ...prev,
                            bloodPressureMap: val
                          }));
                        }} />
                      <span className="text-[8px] text-blue-500/70 font-mono">mmHg</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Alert if no vital signs are registered */}
          {!(
            vitals.heartRate !== '' ||
            vitals.spo2 !== '' ||
            vitals.temperature !== '' ||
            vitals.respiratoryRate !== '' ||
            vitals.bloodPressureSys !== '' ||
            vitals.bloodPressureDia !== ''
          ) && (
            <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 rounded-xl text-xs font-semibold flex items-center justify-between gap-2 animate-pulse">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-bounce"></span>
                <span>No hay signos vitales</span>
              </div>
              <span className="text-[10px] text-red-500/70 font-normal">Ingrese los datos clínicos del paciente para iniciar el proceso de triage.</span>
            </div>
          )}
        </section>

        {/* 3. GLASGOW */}
        <section className={`${t.card} rounded-xl p-5 border shadow-sm`}>
          <div className="flex justify-between items-center mb-4">
            <h2 className={`${t.heading} text-sm font-bold uppercase tracking-wider opacity-80`}>3. Escala de Glasgow (GCS)</h2>
            <div className={`flex items-center gap-2 ${t.iconBg} px-3 py-1 rounded-md border ${t.border}`}>
              <span className={`text-xs ${t.muted} font-medium`}>Total:</span>
              {glasgow.total === null ? (
                // Sin valor por defecto: hasta que se elijan las tres subescalas no hay total
                <span className={`text-sm font-bold ${t.muted}`}>— <span className="text-[10px] font-medium">(sin evaluar)</span></span>
              ) : (
                <span className={`text-lg font-black ${glasgow.total <= 8 ? 'text-red-500' : glasgow.total <= 13 ? 'text-orange-500' : 'text-green-500'}`}>
                  {glasgow.total}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { label: 'Apertura Ocular', key: 'eyeOpening', options: GLASGOW_OPTIONS.eye },
              { label: 'Respuesta Verbal', key: 'verbalResponse', options: GLASGOW_OPTIONS.verbal },
              { label: 'Respuesta Motora', key: 'motorResponse', options: GLASGOW_OPTIONS.motor },
            ].map(({ label, key, options }) => (
              <div key={key} className="space-y-1.5">
                <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider block text-center`}>{label}</label>
                <div className="flex flex-col gap-1.5">
                  {options.map(opt => (
                    <button key={opt.val} onClick={() => setGlasgow(prev => ({ ...prev, [key]: opt.val }))}
                      className={`px-2 py-1.5 rounded-md text-xs font-medium transition-all border ${
                        (glasgow as any)[key] === opt.val ? 'bg-purple-600 border-purple-500 text-white' : t.button
                      }`}>{opt.label}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 4. ESCALA EVA — solo informativa */}
        <section className={`${t.card} rounded-xl p-5 border shadow-sm`}>
          <div className="flex justify-between items-center mb-3">
            <div>
              <h2 className={`${t.heading} text-sm font-bold uppercase tracking-wider opacity-80`}>4. Escala EVA — Dolor</h2>
            </div>
            <span className={`text-xl font-black ${t.heading}`}>{vitals.painLevel}</span>
          </div>
          <div className="flex justify-between gap-1">
            {[0,1,2,3,4,5,6,7,8,9,10].map(val => {
              let colorClass = t.button;
              if (vitals.painLevel === val) {
                if (val <= 3) colorClass = 'bg-green-500 text-white border-green-400';
                else if (val <= 7) colorClass = 'bg-yellow-500 text-white border-yellow-400';
                else colorClass = 'bg-red-600 text-white border-red-500';
              }
              return (
                <button key={val} onClick={() => setVitals(prev => ({ ...prev, painLevel: val }))}
                  className={`flex-1 aspect-square rounded-md flex items-center justify-center text-xs font-bold border transition-all hover:scale-105 ${colorClass}`}>
                  {val}
                </button>
              );
            })}
          </div>
        </section>

        {/* 5. ANÁLISIS DE SÍNTOMAS CON INTELIGENCIA ARTIFICIAL (GEMINI) */}
        <section className={`${t.card} rounded-xl p-5 border shadow-sm relative overflow-hidden`}>
          {/* Sutil efecto de fondo */}
          <div className="absolute top-0 right-0 w-48 h-48 bg-blue-500/5 rounded-full blur-3xl -z-10 pointer-events-none"></div>
          
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
            <div>
              <h2 className={`${t.heading} text-sm font-bold uppercase tracking-wider opacity-80 flex items-center gap-2`}>
                <Brain className="w-5 h-5 text-blue-500 animate-pulse" />
                5. Análisis de Síntomas con IA Clínica
              </h2>
              <p className={`text-[11px] ${t.muted} mt-0.5`}>
                La Inteligencia Artificial analiza de forma integral los relatos de consulta, signos vitales y datos del paciente para deducir los síntomas clínicos objetivos y sugerir la clasificación de Triage de acuerdo con la normatividad colombiana (Resolución 5596 de 2015).
              </p>
            </div>
            
            <button
              onClick={handleAnalyzeSymptomsWithAI}
              // Exige los dos campos de relato (misma regla que el servidor en /api/triage/analyze)
              disabled={isAiAnalyzing || missingNarrative.length > 0}
              className={`px-4 py-2 rounded-xl text-xs font-bold font-mono transition-all flex items-center gap-2 shadow-sm ${
                isAiAnalyzing 
                  ? 'bg-blue-600/25 text-blue-400 border border-blue-500/30 cursor-not-allowed animate-pulse'
                  : missingNarrative.length > 0
                  ? (isDarkMode 
                      ? 'bg-slate-900 border border-slate-800 text-slate-600 cursor-not-allowed' 
                      : 'bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed')
                  : 'bg-blue-600 hover:bg-blue-500 text-white border border-blue-500 hover:shadow-[0_0_15px_rgba(59,130,246,0.4)] active:scale-95'
              }`}
              type="button"
            >
              {isAiAnalyzing ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Analizando...
                </>
              ) : (
                <>
                  <Brain className="w-4 h-4" />
                  Iniciar Análisis IA
                </>
              )}
            </button>
          </div>
          {missingNarrative.length > 0 && !isAiAnalyzing && (
            <p className="-mt-2 mb-3 text-[11px] font-semibold text-amber-600 dark:text-amber-400 text-right">
              Para analizar con IA complete: {missingNarrative.join(' y ')}
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Input display context of the analysis text */}
            <div className="md:col-span-2 space-y-3">
              <div className="text-xs space-y-1">
                <span className={`block font-bold ${t.muted} uppercase tracking-wider text-[10px]`}>
                  Contexto Clínico Narrado a Evaluar:
                </span>
                <div className={`p-3 rounded-lg text-xs border ${t.border} ${isDarkMode ? 'bg-slate-950/60 text-slate-200' : 'bg-white text-slate-800'} leading-relaxed space-y-2 max-h-[180px] overflow-y-auto`}>
                  {patientInfo.symptoms ? (
                    <div>
                      <span className={`font-bold ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>Motivo de consulta:</span> "{patientInfo.symptoms}"
                    </div>
                  ) : null}
                  {patientInfo.currentIllness ? (
                    <div>
                      <span className={`font-bold ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>Enfermedad actual:</span> "{patientInfo.currentIllness}"
                    </div>
                  ) : null}
                  {!patientInfo.symptoms && !patientInfo.currentIllness && (
                    <span className="text-slate-500 italic font-mono">Escriba el motivo de consulta o la enfermedad actual en la sección 1 (Datos del Paciente) para habilitar el análisis de síntomas por IA.</span>
                  )}
                </div>
              </div>

              {/* Badges of Detected Symptoms */}
              {aiExtractedSymptoms.length > 0 && (
                <div className="space-y-1.5 animate-fade-in">
                  <span className={`block font-bold ${t.muted} uppercase tracking-wider text-[10px]`}>
                    Médula de Síntomas Identificados:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {aiExtractedSymptoms.map((sym, i) => (
                      <span key={i} className={`px-2.5 py-1 rounded-full text-[10px] border flex items-center gap-1 ${
                        isDarkMode 
                          ? 'bg-sky-950/50 text-sky-300 border-sky-500/30' 
                          : 'bg-sky-50 text-sky-700 border-sky-200 font-semibold'
                      }`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse"></span>
                        {sym}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right column: AI diagnostic box */}
            <div className={`p-4 rounded-xl border flex flex-col justify-between transition-all duration-300 ${
              aiTriageResponse 
                ? (isDarkMode ? 'border-blue-500/30 bg-blue-500/5' : 'border-blue-300 bg-blue-50/50') 
                : (isDarkMode ? 'bg-slate-900/30 border-slate-800/80 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600')
            }`}>
              <div className="space-y-3">
                <h3 className={`text-xs font-black uppercase tracking-wider ${t.heading} flex items-center gap-1.5`}>
                  <Brain className="w-4 h-4 text-blue-500" />
                  Sugerencia IA
                </h3>
                
                {aiTriageResponse ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className={`px-3 py-1.5 rounded-lg text-xs font-black font-mono shadow-sm ${getTriageColor(aiTriageResponse.aiLevel)}`}>
                        {getTriageLabel(aiTriageResponse.aiLevel)}
                      </span>
                      {aiTriageResponse.aiLevel !== triageResult.level && (
                        <span className="text-[10px] font-mono text-amber-500 font-bold bg-amber-500/10 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                          <AlertTriangle className="w-3 h-3" />
                          Difieren
                        </span>
                      )}
                    </div>
                    <p className={`text-[11px] leading-relaxed italic ${isDarkMode ? 'text-slate-300' : 'text-slate-700 font-medium'}`}>
                      "{aiTriageResponse.explanation}"
                    </p>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <Brain className="w-8 h-8 text-slate-500 mx-auto opacity-30" />
                    <p className={`text-[11px] ${t.muted} mt-2`}>
                      Haga clic en "Iniciar Análisis IA" para clasificar automáticamente.
                    </p>
                  </div>
                )}
              </div>

              {aiTriageResponse && (
                <div className="pt-2 border-t border-slate-800/50 mt-3 flex justify-end">
                  <button
                    onClick={handleApplyAiTriage}
                    disabled={finalLevel === aiTriageResponse.aiLevel}
                    className={`w-full py-2 rounded-lg text-[10px] uppercase font-bold font-mono transition-all ${
                      finalLevel === aiTriageResponse.aiLevel
                        ? 'bg-slate-100 dark:bg-slate-800 border border-slate-250 dark:border-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                        : 'bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                    }`}
                    type="button"
                  >
                    {finalLevel === aiTriageResponse.aiLevel ? 'Nivel de Triage Aplicado' : 'Aplicar Decisión IA'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {aiErrorMsg && (
            <div className="mt-3 p-3 rounded-lg text-xs bg-red-500/10 border border-red-500/20 text-red-500 dark:text-red-400 font-mono">
              <p className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />
                Error de Diagnóstico IA:
              </p>
              <p className="mt-1 opacity-90">{aiErrorMsg}</p>
            </div>
          )}
        </section>

        {/* 6. NIVEL SUGERIDO + DECISIÓN MÉDICA */}
        <section className={`${t.card} rounded-xl p-5 border shadow-sm`}>
          <h2 className={`${t.heading} text-sm font-bold mb-4 uppercase tracking-wider opacity-80`}>6. Nivel Sugerido y Decisión Médica</h2>

          {/* Badge nivel sugerido */}
          <div className={`mb-4 p-4 rounded-xl border flex flex-col items-center justify-center transition-all duration-500 ${getTriageColor(suggestedLevel)}`}>
            <span className="text-[10px] font-bold uppercase tracking-widest opacity-80 mb-1">Nivel Sugerido por el Sistema</span>
            <span className="text-2xl font-black tracking-tight text-center">{getTriageLabel(suggestedLevel)}</span>
            <span className="text-xs mt-1 opacity-90 font-medium">Tiempo máx: {formatAttentionTime(getAttentionTime(suggestedLevel))}</span>
          </div>

          {/* Razones del nivel — transparencia clínica */}
          {triageResult.reasons.length > 0 && (
            <div className={`mb-4 p-3 rounded-lg border ${t.border} ${t.iconBg}`}>
              <p className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider mb-2`}>Factores determinantes</p>
              <ul className="space-y-1">
                {triageResult.reasons
                  .filter(r => r.suggestedLevel === suggestedLevel)
                  .slice(0, 4)
                  .map((r, i) => (
                    <li key={i} className={`text-[11px] ${t.text} flex items-start gap-1.5`}>
                      <span className="opacity-50 mt-0.5">→</span> {r.description}
                    </li>
                  ))}
              </ul>
              {triageResult.modifiersApplied.length > 0 && (
                <div className="mt-2 pt-2 border-t border-amber-500/20">
                  <p className="text-[10px] text-amber-500 font-bold uppercase tracking-wider mb-1">Modificadores aplicados</p>
                  {triageResult.modifiersApplied.map((m, i) => (
                    <p key={i} className="text-[11px] text-amber-400">⚠ {m}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Override médico */}
          <div className="mb-6 space-y-3">
            <label className={`text-[10px] font-bold ${t.muted} uppercase tracking-wider block`}>Nivel Final (Decisión Médica)</label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(lvl => (
                <button key={lvl} onClick={() => setFinalLevel(lvl as ESILevel)}
                  className={`flex-1 py-2 rounded-md text-xs font-bold border transition-colors ${
                    finalLevel === lvl ? t.buttonActive : t.button
                  }`}>T{lvl}</button>
              ))}
            </div>
            {suggestedLevel !== finalLevel && (
              <div className="mt-3">
                <label className="text-[10px] font-bold text-amber-500 mb-1 block uppercase tracking-wider">⚠️ Justificación de Cambio Requerida</label>
                <textarea className={`w-full ${t.iconBg} border border-amber-500/50 rounded-lg px-3 py-2 ${t.heading} text-xs focus:ring-1 focus:ring-amber-500`}
                  placeholder="Explique por qué modifica el nivel sugerido..."
                  value={overrideReason} onChange={e => setOverrideReason(e.target.value)} />
              </div>
            )}
            {isCorrectionMode && (
              <div className="mt-3">
                <label className="text-[10px] font-bold text-amber-500 mb-1 block uppercase tracking-wider">⚠️ Razón de la Corrección</label>
                <textarea className={`w-full ${t.iconBg} border border-amber-500/50 rounded-lg px-3 py-2 ${t.heading} text-xs focus:ring-1 focus:ring-amber-500`}
                  placeholder="Ej: Error de digitación en signos vitales..."
                  value={correctionReason} onChange={e => setCorrectionReason(e.target.value)} />
              </div>
            )}
            {isReEvaluationMode && (
              <div className="mt-3">
                <label className="text-[10px] font-bold text-blue-500 mb-1 block uppercase tracking-wider">⚠️ Motivo de la Re-evaluación</label>
                <textarea className={`w-full ${t.iconBg} border border-blue-500/50 rounded-lg px-3 py-2 ${t.heading} text-xs focus:ring-1 focus:ring-blue-500`}
                  placeholder="Ej: El paciente presenta deterioro hemodinámico, aumento de dolor, o alteración de estado..."
                  value={correctionReason} onChange={e => setCorrectionReason(e.target.value)} />
              </div>
            )}
          </div>

          {/* Tras un ERROR el botón vuelve a habilitarse para reintentar; el formulario conserva los datos */}
          {/* Campos obligatorios pendientes: el botón queda deshabilitado y se listan aquí (misma regla que el servidor) */}
          {missingRequired.length > 0 && (status === 'IDLE' || status === 'ERROR') && (
            <div className="mb-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs">
              <p className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0" /> Campos obligatorios pendientes para guardar:
              </p>
              <ul className="mt-1.5 ml-6 list-disc space-y-0.5">
                {missingRequired.map(label => <li key={label}>{label}</li>)}
              </ul>
            </div>
          )}
          <button onClick={handleSubmit} disabled={(status !== 'IDLE' && status !== 'ERROR') || missingRequired.length > 0}
            className={`w-full py-3.5 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all ${
              (status !== 'IDLE' && status !== 'ERROR') || missingRequired.length > 0
                ? `${isDarkMode ? 'bg-slate-800 text-slate-500' : 'bg-slate-200 text-slate-400'} cursor-not-allowed`
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md'
            }`}>
            {status === 'IDLE'    && <><Save className="w-4 h-4" /> Guardar Triage</>}
            {status === 'MINING'  && <><RefreshCw className="w-4 h-4 animate-spin" /> Guardando Triage...</>}
            {status === 'SUCCESS' && <span className="text-green-400">✅ ¡Guardado Exitoso!</span>}
            {status === 'ERROR'   && <><RefreshCw className="w-4 h-4" /> Reintentar</>}
          </button>
          {status === 'ERROR' && (
            <p className="text-center text-xs text-red-500 mt-2 font-semibold">❌ Error: {statusMsg}</p>
          )}
          {statusMsg && status !== 'SUCCESS' && status !== 'ERROR' && (
            <p className={`text-center text-[10px] ${t.muted} mt-2 font-mono animate-pulse`}>{statusMsg}</p>
          )}

          {vitals.heartRate === 0 && vitals.bloodPressureSys === 0 && (
            <div className="mt-4 p-4 border-2 border-red-600 bg-red-500/10 text-red-600 dark:text-red-400 rounded-xl text-center font-black text-sm uppercase tracking-wider animate-pulse flex items-center justify-center gap-2">
              <span>🛑 No hay signos vitales</span>
            </div>
          )}
        </section>

      </div>
    </div>
  );
};

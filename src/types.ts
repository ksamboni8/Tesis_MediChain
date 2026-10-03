
// Usamos 'as const' para simular enums de forma compatible con JS moderno
export const UserRole = {
  DOCTOR: 'DOCTOR',
  AUDITOR: 'AUDITOR',
  ADMIN: 'ADMIN', // Simulates the System Designer / DB Admin
  ADMISSION: 'ADMISSION',
  NONE: 'NONE'
} as const;

// Creamos un tipo que sea la unión de los valores del objeto
export type UserRole = typeof UserRole[keyof typeof UserRole];

export const ESILevel = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5
} as const;

export type ESILevel = typeof ESILevel[keyof typeof ESILevel];

export interface VitalSigns {
  heartRate: number;
  spo2: number;
  temperature: number;
  respiratoryRate: number;
  bloodPressureSys: number;
  bloodPressureDia: number;
  bloodPressureMap?: number; // Presión Arterial Media (PAM)
  painLevel: number; // 0-10
}

export interface GlasgowScale {
  eyeOpening: number; // 1-4
  verbalResponse: number; // 1-5
  motorResponse: number; // 1-6
  total: number; // 3-15
}

export interface ESIChecklist {
  // --- TRIAGE 1 CRITERIA (Emergencia Vital) ---
  
  // A. Airway & Ventilation
  obstruccionViaAerea: boolean;
  insuficienciaRespSevera: boolean;
  hipoxiaCritica: boolean;
  esfuerzoAgotado: boolean;
  toraxSilente: boolean;

  // B. Circulation
  paroCardioresp: boolean;
  shockClinico: boolean;
  arritmiaInestable: boolean;
  perfusionCritica: boolean;
  dolorToracicoIsquemico: boolean;

  // C. Neuro
  deterioroAgudoGlasgow: boolean;
  estatusEpileptico: boolean;
  focalidadNeuroAguda: boolean;
  estadoInconsciencia: boolean;

  // D. Trauma
  hemorragiaMasiva: boolean;
  traumaAltaEnergia: boolean;
  heridasPenetrantes: boolean;
  amputacionTraumatica: boolean;
  traumaCranealGrave: boolean;

  // E. Burns & Tox
  quemaduraViaAerea: boolean;
  quemaduraCritica: boolean;
  anafilaxia: boolean;
  intoxicacionAguda: boolean;

  // F. Metabolic
  hipoglucemiaCritica: boolean;
  sepsisHipotension: boolean;
  crisisMetabolica: boolean;

  // --- TRIAGE 2 CRITERIA (Urgencia) ---
  
  // A. Cardio
  dolorToracicoIAM: boolean;
  equivalenteAnginoso: boolean;
  signosBajoGasto: boolean;
  crisisHipertensiva: boolean;

  // B. Resp
  hipoxemiaLeve: boolean;
  taquipneaSignificativa: boolean;
  esfuerzoParcial: boolean;
  estridorLeve: boolean;

  // C. Neuro
  glasgow9_13: boolean;
  deficitFocalVentana: boolean;
  cefaleaTrueno: boolean;
  estadoPostIctal: boolean;

  // D. Metabolic
  sepsisTemprana: boolean;
  desequilibrioGlucemico: boolean;
  abdomenAgudo: boolean;
  deshidratacionGrave: boolean;

  // E. Trauma
  traumaCranealTCE: boolean;
  traumaAltaEnergiaEstable: boolean;
  quemadurasEspeciales: boolean;
  fracturasMayores: boolean;
  traumaOcular: boolean;

  // F. Vulnerable
  neonatoRiesgo: boolean;
  pediatriaFiebre: boolean;
  obstetriciaRiesgo: boolean;
  inmunosuprimido: boolean;

  // G. Psych
  agitacionPsicomotora: boolean;
  ideacionSuicida: boolean;

  // --- TRIAGE 3 CRITERIA ---
  t3_riesgoViolencia: boolean;
  t3_estabilidadVHN: boolean;
  t3_interfiereTrabajo: boolean;
  t3_cefalea: boolean;
  t3_dolorToracico: boolean;
  t3_asmaLeveModerada: boolean;
  t3_sangradoLeveModerado: boolean;
  t3_sistemasDialisis: boolean;
  t3_dolorModerado: boolean;
  t3_quemaduras10Grado2: boolean;

  // --- TRIAGE 4 CRITERIA ---
  t4_patologiasEdad: boolean;
  t4_deterioroPotencial: boolean;
  t4_dolorToracicoNoCoronario: boolean;
  t4_dolorMuscularLeve: boolean;
  t4_cefaleaLeve: boolean;
  t4_dolorAbdominalLeve: boolean;
  t4_depresion: boolean;

  // --- TRIAGE 5 CRITERIA ---
  t5_condicionAgudaNoCompromete: boolean;
  t5_problemasCronicosSinDeterioro: boolean;
  t5_traumaMenor: boolean;
  t5_estresEmocional: boolean;
  t5_faringitis: boolean;
  t5_amigdalitis: boolean;
  t5_quemadurasGrado1: boolean;

  // Legacy/Fallback (Optional or remove if fully replaced)
  confusedLethargic: boolean;
  severePainDistress: boolean; 
  highRiskCondition: boolean; 
}

// The raw data stored in MongoDB (Off-chain)
export interface PatientData {
  id: string; // Internal UUID
  cedula: string; // Government ID
  name: string;
  age: number;
  gender: 'M' | 'F' | 'O';
  eps: string; // EPS (Entidad de Salud)
  symptoms: string; // Motivo de Consulta (Relato del Paciente)
  currentIllness: string; // Enfermedad Actual (Relato Médico)
  vitals: VitalSigns;
  glasgow: GlasgowScale; // NEW: Glasgow Coma Scale
  
  // ESI Specifics
  checklist: ESIChecklist;
  selectedSymptoms?: string[]; // NEW: For the modern UI
  
  suggestedEsiLevel: ESILevel; // Nivel mostrado al médico como sugerencia (el de la IA si se ejecutó, si no el del algoritmo)
  finalEsiLevel: ESILevel; // Selected by Doctor
  aiLevel: ESILevel | null; // Nivel devuelto por la IA en este triage; null si no se ejecutó
  aiModelUsed: string | null; // Modelo Gemini que respondió (_metrics.modelUsed); null si no aplica. Fuera del hash
  overrideReason?: string; // Required if Suggested != Final
  
  triageTimestamp: number;
  estimatedAttentionTime: number; // Calculated timestamp based on ESI
  attentionTimestamp?: number; // NEW: Actual time the patient was seen
  
  // Traceability for Corrections
  parentRecordHash?: string; // NEW: Hash of the previous record if this is a correction
  correctionReason?: string; // NEW: Why was it corrected?

  doctorId: string;
}

// The record representing the link between DB and Blockchain
export interface HybridRecord {
  _id: string; // MongoDB ID
  patientData: PatientData; // The actual medical content
  blockchainHash: string; // The immutable hash stored on-chain (Data Fingerprint)
  blockchainSignature: string; // The doctor's signature
  transactionHash?: string; // NEW: The Polygon TX Receipt Hash
  isSynced: boolean; // Helper for frontend state
  createdAt: string;
}

export interface PendingPatient {
  id: string;
  cedula: string;
  name: string;
  age: number;
  gender: 'M' | 'F' | 'O';
  eps: string;
  admissionTimestamp: number;
}

export interface TelemetryLog {
  id: string;
  timestamp: number;
  patientName: string;
  t_iot: number | null;   // Estabilización / Adquisición IoT BLE (s), null si no se conectó hardware físico
  isBleConnected?: boolean; // Indica si se utilizó hardware BLE físico
  t_ai: number | null;   // Inferencia IA Gemini (s), null si no hubo métrica real
  t_db_hash: number;     // Persistencia MongoDB & Hash SHA-256 (s)
  t_ui: number | null;   // Tiempo de respuesta al guardar (s): clic Guardar → respuesta del servidor con registro anclado y guardado
  t_blockchain: number | null; // Anclaje en Blockchain / Relayer (s), null si no hubo métrica real
  t_hash_ms?: number | null;  // Cálculo SHA-256 en el servidor (ms); ausente/null en registros previos
  t_firma_ms?: number | null; // Firma ECDSA del relayer en el servidor (ms); ausente/null en registros previos
  // Costos por triage (null = sin dato real; ausente en registros previos). No entran en el hash
  gas_used?: number | null;                  // receipt.gasUsed
  effective_gas_price_wei?: string | null;   // receipt.effectiveGasPrice en wei (texto decimal exacto)
  cost_pol?: string | null;                  // gasUsed × effectiveGasPrice en POL (texto decimal exacto)
  ai_tokens_in?: number | null;              // Gemini usageMetadata.promptTokenCount
  ai_tokens_out?: number | null;             // Gemini candidatesTokenCount + thoughtsTokenCount
  ai_models_tried?: number | null;           // Modelos probados en la cascada hasta obtener respuesta
  isRealMeasurement?: boolean; // Indica si la medición fue exitosa sin fallbacks de error
  errorReason?: string;  // Razón de descarte si es medición no válida
}

export interface MetricSummary {
  phase: string;
  min: number;
  avg: number;
  max: number;
  stdDev?: number;
}


// Estadística de una métrica en milisegundos con el tamaño de muestra (registros con valor no nulo)
export interface MsMetricSummary extends MetricSummary {
  n: number;
}

// Estadística de un costo por triage, sin redondear (el costo en POL es del orden de 1e-3)
export interface CostMetricSummary extends MsMetricSummary {
  unit: string;
  decimals: number; // Decimales con que se muestra
}

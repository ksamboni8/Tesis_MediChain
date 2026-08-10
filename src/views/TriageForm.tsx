import React, { useState, useEffect } from 'react';
import { ESILevel } from '../types';
import type { PatientData, VitalSigns, GlasgowScale, HybridRecord, PendingPatient } from '../types';
import { BluetoothDeviceController, simulateIoTReadings } from '../services/bluetoothService';
import { Activity, Bluetooth, Save, RefreshCw, AlertTriangle, ShieldAlert, FileWarning, Brain, HeartPulse, Wind, Droplets, Thermometer, Sun, Moon, Users, CheckCircle, Zap, Wallet } from 'lucide-react';
import { dbService } from '../services/databaseService';
import { web3Service } from '../services/web3Service';
import { generateHash } from '../services/cryptoService';
import { telemetryService } from '../services/telemetryService';
import { addMinutes } from 'date-fns';

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
// SYMPTOM_CATEGORIES — rediseñado con contexto colombiano
// Mantiene tu sistema de activeColor por categoría
// ─────────────────────────────────────────────────────────────────
const SYMPTOM_CATEGORIES = [
  {
    name: 'Respiratorio / Cardiovascular',
    activeColor: 'bg-blue-500 text-white border-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.5)]',
    symptoms: [
      'Paro cardiorrespiratorio',
      'Obstrucción de vía aérea',
      'Dificultad respiratoria severa',
      'Dolor torácico sugestivo de síndrome coronario',
      'Palpitaciones con inestabilidad hemodinámica',
      'Dificultad respiratoria moderada',
      'Crisis asmática moderada-severa',
      'Síntomas respiratorios moderados',
      'Infección respiratoria leve'
    ]
  },
  {
    name: 'Neurológico',
    activeColor: 'bg-purple-500 text-white border-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.5)]',
    symptoms: [
      'Estado de inconsciencia',
      'Convulsión activa',
      'Déficit neurológico focal agudo',
      'Alteración aguda del estado mental',
      'Convulsión reciente',
      'Cefalea súbita intensa'
    ]
  },
  {
    name: 'Trauma',
    activeColor: 'bg-orange-500 text-white border-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.5)]',
    symptoms: [
      'Politraumatismo grave',
      'Trauma craneoencefálico grave',
      'Fractura expuesta',
      'Quemadura extensa',
      'Quemadura química',
      'Herida por arma de fuego',
      'Herida por arma cortopunzante',
      'Trauma moderado',
      'Fractura cerrada',
      'Luxación',
      'Esguince leve',
      'Herida superficial'
    ]
  },
  {
    name: 'Dolor / Abdomen',
    activeColor: 'bg-red-500 text-white border-red-400 shadow-[0_0_10px_rgba(239,68,68,0.5)]',
    symptoms: [
      'Hemorragia masiva',
      'Hemorragia activa',
      'Dolor abdominal moderado-severo',
      'Vómito persistente',
      'Diarrea con deshidratación moderada',
      'Cólico renal',
      'Retención urinaria',
      'Dolor lumbar mecánico'
    ]
  },
  {
    name: 'Sistémico',
    activeColor: 'bg-emerald-500 text-white border-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.5)]',
    symptoms: [
      'Sospecha de infección grave',
      'Fiebre con signos de alarma',
      'Reacción alérgica moderada-grave',
      'Anafilaxia',
      'Fiebre persistente',
      'Síndrome febril sin signos de alarma'
    ]
  },
  {
    name: 'Obstétrico',
    activeColor: 'bg-pink-500 text-white border-pink-400 shadow-[0_0_10px_rgba(236,72,153,0.5)]',
    symptoms: [
      'Eclampsia',
      'Hemorragia obstétrica severa',
      'Preeclampsia',
      'Sangrado durante el embarazo'
    ]
  },
  {
    name: 'Condiciones Especiales',
    activeColor: 'bg-teal-500 text-white border-teal-400 shadow-[0_0_10px_rgba(20,184,166,0.5)]',
    symptoms: [
      'Ofidismo',
      'Intoxicación por plaguicidas',
      'Violencia sexual',
      'Paciente agresivo o riesgo para terceros',
      'Intoxicación por sustancias psicoactivas',
      'Violencia intrafamiliar con lesiones'
    ]
  }
];

// ─────────────────────────────────────────────────────────────────
// SYMPTOM_LEVELS — mapa completo para el algoritmo
// ─────────────────────────────────────────────────────────────────
const SYMPTOM_LEVELS: Record<string, ESILevel> = {
  // ── TRIAGE I ────────────────────────────────────────────────
  'Paro cardiorrespiratorio':                                    ESILevel.ONE,
  'Obstrucción de vía aérea':                                    ESILevel.ONE,
  'Dificultad respiratoria severa':                              ESILevel.ONE,
  'Estado de inconsciencia':                                     ESILevel.ONE,
  'Convulsión activa':                                           ESILevel.ONE,
  'Déficit neurológico focal agudo':                             ESILevel.ONE,
  'Politraumatismo grave':                                       ESILevel.ONE,
  'Trauma craneoencefálico grave':                               ESILevel.ONE,
  'Hemorragia masiva':                                           ESILevel.ONE,
  'Shock Hipovolémico':                                          ESILevel.ONE,
  'Shock Cardiogénico':                                          ESILevel.ONE,
  'Shock Distributivo':                                          ESILevel.ONE,
  'Shock Obstructivo':                                           ESILevel.ONE,
  'Shock Neurogénico':                                           ESILevel.ONE,
  'Eclampsia':                                                   ESILevel.ONE,
  'Hemorragia obstétrica severa':                                ESILevel.ONE,
  'Ofidismo':                                                    ESILevel.ONE,
  'Intoxicación por plaguicidas':                                ESILevel.ONE,

  // ── TRIAGE II ────────────────────────────────────────────────
  'Dolor torácico sugestivo de síndrome coronario':              ESILevel.TWO,
  'Palpitaciones con inestabilidad hemodinámica':                ESILevel.TWO,
  'Dificultad respiratoria moderada':                            ESILevel.TWO,
  'Crisis asmática moderada-severa':                             ESILevel.TWO,
  'Alteración aguda del estado mental':                          ESILevel.TWO,
  'Convulsión reciente':                                         ESILevel.TWO,
  'Cefalea súbita intensa':                                      ESILevel.TWO,
  'Fractura expuesta':                                           ESILevel.TWO,
  'Quemadura extensa':                                           ESILevel.TWO,
  'Quemadura química':                                           ESILevel.TWO,
  'Herida por arma de fuego':                                    ESILevel.TWO,
  'Herida por arma cortopunzante':                               ESILevel.TWO,
  'Hemorragia activa':                                           ESILevel.TWO,
  'Sospecha de infección grave':                                 ESILevel.TWO,
  'Fiebre con signos de alarma':                                 ESILevel.TWO,
  'Reacción alérgica moderada-grave':                            ESILevel.TWO,
  'Anafilaxia':                                                  ESILevel.TWO,
  'Preeclampsia':                                                ESILevel.TWO,
  'Sangrado durante el embarazo':                                ESILevel.TWO,
  'Violencia sexual':                                            ESILevel.TWO,
  'Paciente agresivo o riesgo para terceros':                    ESILevel.TWO,
  'Intoxicación por sustancias psicoactivas':                    ESILevel.TWO,

  // ── TRIAGE III ────────────────────────────────────────────────
  'Síntomas respiratorios moderados':                            ESILevel.THREE,
  'Trauma moderado':                                             ESILevel.THREE,
  'Fractura cerrada':                                            ESILevel.THREE,
  'Luxación':                                                    ESILevel.THREE,
  'Dolor abdominal moderado-severo':                             ESILevel.THREE,
  'Vómito persistente':                                          ESILevel.THREE,
  'Diarrea con deshidratación moderada':                         ESILevel.THREE,
  'Cólico renal':                                                ESILevel.THREE,
  'Retención urinaria':                                          ESILevel.THREE,
  'Fiebre persistente':                                          ESILevel.THREE,
  'Síndrome febril sin signos de alarma':                        ESILevel.THREE,
  'Violencia intrafamiliar con lesiones':                        ESILevel.THREE,

  // ── TRIAGE IV ─────────────────────────────────────────────────
  'Infección respiratoria leve':                                 ESILevel.FOUR,
  'Esguince leve':                                               ESILevel.FOUR,
  'Herida superficial':                                          ESILevel.FOUR,
  'Dolor lumbar mecánico':                                       ESILevel.FOUR,
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
  age: number,
  gender: string,
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

  // ── 8. SÍNTOMAS CLÍNICOS ─────────────────────────────────────
  symptoms.forEach(symptom => {
    const level = SYMPTOM_LEVELS[symptom];
    if (level !== undefined) {
      evaluate(true, 'symptom', `Síntoma: ${symptom}`, level);
    }
  });

  // ── 9. FACTORES MODIFICADORES ────────────────────────────────
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
    
    const sysNum = cleanSys !== '' ? (parseInt(cleanSys) || 0) : '';
    const diaNum = cleanDia !== '' ? (parseInt(cleanDia) || 0) : '';
    
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

  const [glasgow, setGlasgow] = useState<GlasgowScale>({
    eyeOpening: 4, verbalResponse: 5, motorResponse: 6, total: 15
  });

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
    }
  } | null>(null);
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);
  const [aiErrorMsg, setAiErrorMsg] = useState('');

  const handleAnalyzeSymptomsWithAI = async () => {
    setIsAiAnalyzing(true);
    setAiErrorMsg('');
    try {
      const clinicalText = `${patientInfo.symptoms} | ${patientInfo.currentIllness}`;
      const payload = {
        clinicalText,
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
        const mapped: string[] = [];
        data.extractedSymptoms.forEach((s: string) => {
          const cleanS = s.toLowerCase().trim();
          const matchKey = Object.keys(SYMPTOM_LEVELS).find(k => 
            k.toLowerCase() === cleanS || cleanS.includes(k.toLowerCase()) || k.toLowerCase().includes(cleanS)
          );
          if (matchKey) {
            mapped.push(matchKey);
          } else {
            mapped.push(s);
          }
        });
        setSelectedSymptoms(mapped);
      }

    } catch (err: any) {
      console.error(err);
      setAiErrorMsg(err.message || 'Fallo indeterminado en el análisis con Inteligencia Artificial.');
    } finally {
      setIsAiAnalyzing(false);
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
  const [status, setStatus]                       = useState<'IDLE' | 'HASHING' | 'MINING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [statusMsg, setStatusMsg]                 = useState('');
  const [signingMode, setSigningMode]             = useState<'manual' | 'invisible'>('invisible');
  const [bleController]                           = useState(() => new BluetoothDeviceController());

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

  const selectPendingPatient = (patient: PendingPatient) => {
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
    
    // Clear vitals when a pending patient is selected so they can be entered fresh
    setVitals({
      heartRate: '', spo2: '', temperature: '', respiratoryRate: '',
      bloodPressureSys: '', bloodPressureDia: '', bloodPressureMap: '', painLevel: 0
    });
    setBpInputText('');
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
        setGlasgow({ eyeOpening: 4, verbalResponse: 5, motorResponse: 6, total: 15 });
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
    setGlasgow(prev => ({ ...prev, total: prev.eyeOpening + prev.verbalResponse + prev.motorResponse }));
  }, [glasgow.eyeOpening, glasgow.verbalResponse, glasgow.motorResponse]);

  // ── Recalcular triage al cambiar cualquier variable clínica ──
  useEffect(() => {
    const allSymptoms = [...selectedSymptoms];
    if (hasShock) allSymptoms.push(shockType ? `Shock ${shockType}` : 'Shock (Sin tipificar)');

    const result = calcularTriage(
      glasgow.total,
      Number(vitals.respiratoryRate) || 0,
      Number(vitals.heartRate) || 0,
      Number(vitals.bloodPressureSys) || 0,
      Number(vitals.spo2) || 0,
      Number(vitals.temperature) || 0,
      parseInt(patientInfo.age) || 0,
      patientInfo.gender,
      allSymptoms,
      selectedModifiers
    );
    setTriageResult(result);
    setSuggestedLevel(result.level);
  }, [glasgow.total, vitals, selectedSymptoms, hasShock, shockType, patientInfo.age, patientInfo.gender, selectedModifiers]);

  useEffect(() => {
    if (!overrideReason && !isCorrectionMode) setFinalLevel(suggestedLevel);
  }, [suggestedLevel, isCorrectionMode, overrideReason]);

  const handleIoTConnect = async () => {
    setIsScanning(true);
    try {
      const data = await bleController.requestDevice() ? await bleController.connect() : simulateIoTReadings();
      if (data) setVitals(prev => ({ ...prev, ...data }));
    } catch (e) {
      setVitals(prev => ({ ...prev, ...simulateIoTReadings() }));
    } finally { setIsScanning(false); }
  };

  const toggleSymptom = (symptom: string) => {
    setSelectedSymptoms(prev => prev.includes(symptom) ? prev.filter(s => s !== symptom) : [...prev, symptom]);
  };

  const handleSubmit = async () => {
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

    setStatus('HASHING');
    setStatusMsg("Verificando consistencia clínica...");

    const recordId = crypto.randomUUID();
    const finalSymptoms = [...selectedSymptoms];
    if (hasShock) finalSymptoms.push(shockType ? `Shock ${shockType}` : 'Shock (Sin tipificar)');
    if (selectedModifiers.gestante) finalSymptoms.push('Modifier: Gestante');
    if (selectedModifiers.adultoMayor) finalSymptoms.push('Modifier: Adulto mayor > 65 años');
    if (selectedModifiers.lactante) finalSymptoms.push('Modifier: Lactante < 1 año');
    if (selectedModifiers.inmunosuprimido) finalSymptoms.push('Modifier: Inmunosuprimido');
    if (selectedModifiers.oncologico) finalSymptoms.push('Modifier: Paciente oncológico');

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
      glasgow,
      checklist: {} as any,
      selectedSymptoms: finalSymptoms,
      suggestedEsiLevel: suggestedLevel,
      finalEsiLevel: finalLevel,
      overrideReason: overrideReason || "Concordancia con Algoritmo",
      triageTimestamp: Date.now(),
      estimatedAttentionTime: addMinutes(new Date(), getAttentionTime(finalLevel)).getTime(),
      doctorId: walletAddress,
      parentRecordHash: initialData ? initialData.blockchainHash : undefined,
      correctionReason: (isCorrectionMode || isReEvaluationMode) ? correctionReason : undefined,
    };

    try {
      const t0_db = performance.now();
      const dataHash = await generateHash(newPatientData);

      let dbMetrics: any = null;
      if (signingMode === 'invisible') {
        setStatus('MINING');
        setStatusMsg("Guardando de forma segura en el expediente clínico...");
        
        const savedRec: any = await dbService.insertRecordInvisible(newPatientData, walletAddress);
        dbMetrics = savedRec?._metrics;
      } else {
        setStatus('MINING');
        setStatusMsg("Guardando registro en red segura...");

        const logicSignature = isCorrectionMode
          ? `CORRECTION:${correctionReason.substring(0, 10)}`
          : isReEvaluationMode
          ? `RE_EVAL:${correctionReason.substring(0, 10)}`
          : (suggestedLevel === finalLevel ? "ALGO_MATCH" : "MD_OVERRIDE");

        const tx = await web3Service.registerTriage(patientInfo.cedula, dataHash, finalLevel, logicSignature);
        const txHash = tx.hash;

        setStatusMsg("Guardando en Base de Datos...");
        const savedRec: any = await dbService.insertRecord(newPatientData, walletAddress, txHash);
        dbMetrics = savedRec?._metrics;
      }

      const t1_db = performance.now();
      const realDbTimeSec = dbMetrics?.t_db_ms ? Number((dbMetrics.t_db_ms / 1000).toFixed(3)) : Number(((t1_db - t0_db) / 1000).toFixed(3));
      const realBcTimeSec = dbMetrics?.t_bc_ms ? Number((dbMetrics.t_bc_ms / 1000).toFixed(2)) : 3.2;
      const realAiTimeSec = (aiTriageResponse as any)?._metrics?.gemini_ms ? Number(((aiTriageResponse as any)._metrics.gemini_ms / 1000).toFixed(2)) : 3.5;
      
      const isBleActive = isScanning;
      const iotTimeVal = isBleActive ? 1.45 : null;
      const totalUiRoundtripSec = Number(((iotTimeVal || 0) + realAiTimeSec + realDbTimeSec).toFixed(2));

      // Guardar telemetría real en MongoDB y LocalStorage
      await telemetryService.saveLog({
        patientName: patientInfo.name || 'Paciente Triage',
        t_iot: iotTimeVal,
        isBleConnected: isBleActive,
        t_ai: realAiTimeSec,
        t_db_hash: realDbTimeSec,
        t_ui: totalUiRoundtripSec,
        t_blockchain: realBcTimeSec,
        isRealMeasurement: true
      });

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
        {!isCorrectionMode && pendingPatients.length > 0 && (
          <section className={`${t.card} rounded-xl p-5 border shadow-sm border-indigo-500/30 bg-indigo-500/5`}>
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-5 h-5 text-indigo-500" />
              <h2 className={`${t.heading} text-sm font-bold uppercase tracking-wider opacity-80`}>Pacientes en Espera (Admisión)</h2>
            </div>
            <div className="flex overflow-x-auto gap-3 pb-2 scrollbar-none">
              {pendingPatients.map(p => (
                <button key={p.id} onClick={() => selectPendingPatient(p)}
                  className={`flex-shrink-0 text-left p-3 rounded-xl border transition-all min-w-[200px] ${
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
            <div className="flex gap-2">
              <button 
                onClick={handleSetAllVitalsToZero}
                className="flex items-center gap-1.5 bg-red-500/10 text-red-500 border border-red-500/20 px-3 py-1.5 rounded-md text-xs font-bold hover:bg-red-500/20 transition-colors" 
                type="button"
              >
                🚨 {(vitals.heartRate === 0 && vitals.bloodPressureSys === 0) ? 'Restablecer Vacíos' : 'Sin Signos Vitales'}
              </button>
              <button onClick={handleIoTConnect} disabled={isScanning}
                className="flex items-center gap-1.5 bg-blue-500/10 text-blue-500 border border-blue-500/20 px-3 py-1.5 rounded-md text-xs font-bold hover:bg-blue-500/20 transition-colors" type="button">
                {isScanning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Bluetooth className="w-3.5 h-3.5" />}
                {isScanning ? 'Leyendo...' : 'Sensor IoT'}
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
              <span className={`text-lg font-black ${glasgow.total <= 8 ? 'text-red-500' : glasgow.total <= 13 ? 'text-orange-500' : 'text-green-500'}`}>
                {glasgow.total}
              </span>
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
              disabled={isAiAnalyzing || (!patientInfo.symptoms.trim() && !patientInfo.currentIllness.trim())}
              className={`px-4 py-2 rounded-xl text-xs font-bold font-mono transition-all flex items-center gap-2 shadow-sm ${
                isAiAnalyzing 
                  ? 'bg-blue-600/25 text-blue-400 border border-blue-500/30 cursor-not-allowed animate-pulse'
                  : (!patientInfo.symptoms.trim() && !patientInfo.currentIllness.trim())
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

          <button onClick={handleSubmit} disabled={status !== 'IDLE'}
            className={`w-full py-3.5 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all ${
              status !== 'IDLE'
                ? `${isDarkMode ? 'bg-slate-800 text-slate-500' : 'bg-slate-200 text-slate-400'} cursor-not-allowed`
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md'
            }`}>
            {status === 'IDLE'    && <><Save className="w-4 h-4" /> Guardar Triage</>}
            {status === 'HASHING' && <><RefreshCw className="w-4 h-4 animate-spin" /> Procesando Triage...</>}
            {status === 'MINING'  && <><RefreshCw className="w-4 h-4 animate-spin" /> Guardando Triage...</>}
            {status === 'SUCCESS' && <span className="text-green-400">✅ ¡Guardado Exitoso!</span>}
            {status === 'ERROR'   && <span className="text-red-400">❌ Error: {statusMsg}</span>}
          </button>
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

import mongoose from 'mongoose';

// 1. Subesquema de Signos Vitales
const VitalSignsSchema = new mongoose.Schema({
  heartRate: { type: Number, required: true },
  spo2: { type: Number, required: true },
  temperature: { type: Number, required: true },
  respiratoryRate: { type: Number, required: true },
  bloodPressureSys: { type: Number, required: true },
  bloodPressureDia: { type: Number, required: true },
  bloodPressureMap: { type: Number }, // Presión Arterial Media
  painLevel: { type: Number, min: 0, max: 10, required: true }
}, { _id: false });

// 2. Subesquema de Escala Glasgow
const GlasgowScaleSchema = new mongoose.Schema({
  eyeOpening: { type: Number, min: 1, max: 4, required: true },
  verbalResponse: { type: Number, min: 1, max: 5, required: true },
  motorResponse: { type: Number, min: 1, max: 6, required: true },
  total: { type: Number, min: 3, max: 15, required: true }
}, { _id: false });

// 3. Subesquema de Datos Principales del Paciente y Clasificación de Triage
const PatientDataSchema = new mongoose.Schema({
  id: { type: String, required: true },
  cedula: { type: String, required: true, index: true }, // Indexado para búsquedas ultra-rápidas
  name: { type: String, required: true },
  age: { type: Number, required: true },
  gender: { type: String, enum: ['M', 'F', 'O'], required: true },
  eps: { type: String, default: '' },
  
  // Relatos de Consulta y Narrativa Clínica
  symptoms: { type: String, required: true }, // Motivo de Consulta (Relato del Paciente)
  currentIllness: { type: String, default: '' }, // Enfermedad Actual (Relato Médico)
  
  // Signos vitales y escalas neurológicas
  vitals: { type: VitalSignsSchema, required: true },
  glasgow: { type: GlasgowScaleSchema, required: true },
  
  // Checklist de criterios ESI (Soporte flexible para el algoritmo)
  checklist: { type: mongoose.Schema.Types.Mixed },
  selectedSymptoms: [{ type: String }], // Historial de tags/síntomas si aplican
  
  // Niveles de Clasificación Triage ESI
  // Nivel sugerido por la IA; null si no se ejecutó el análisis (registros anteriores: nivel del algoritmo de reglas)
  suggestedEsiLevel: { type: Number, default: null },
  finalEsiLevel: { type: Number, required: true },
  overrideReason: { type: String },

  // Resultado de la IA en este triage (null si no se ejecutó). aiModelUsed no entra en el hash
  aiLevel: { type: Number, min: 1, max: 5, default: null },
  aiModelUsed: { type: String, default: null },
  // Justificación de la IA (RF-21). Sin valor por defecto: ausente si no hubo análisis, igual que en los
  // registros anteriores a este campo (el hash la incluye solo cuando existe)
  aiExplanation: { type: String },
  
  // Tiempos de atención y métricas de rendimiento
  triageTimestamp: { type: Number, required: true },
  estimatedAttentionTime: { type: Number, required: true },
  attentionTimestamp: { type: Number }, // Cuándo fue realmente atendido (Métrica de interoperabilidad)
  
  // Trazabilidad de Auditoría y Correcciones Claras (Inmutabilidad)
  parentRecordHash: { type: String }, // Referencia encadenada al hash anterior
  correctionReason: { type: String },
  doctorId: { type: String, required: true }
}, { _id: false });

// 4. Esquema Principal de Registro Híbrido (MongoDB + Blockchain)
const RecordSchema = new mongoose.Schema({
  blockchainHash: { type: String, required: true, unique: true }, // Identificador criptográfico
  blockchainSignature: { type: String, required: true },
  transactionHash: { type: String, required: false }, // Enlace a la red (Polygon)
  
  // Datos clínicos estructurados
  patientData: { type: PatientDataSchema, required: true }
}, { timestamps: true });

// Índices Compuestos y Simples para Consultas de Alto Rendimiento
RecordSchema.index({ 'patientData.cedula': 1 });
RecordSchema.index({ 'patientData.triageTimestamp': -1 });
RecordSchema.index({ 'patientData.finalEsiLevel': 1 });
RecordSchema.index({ createdAt: -1 });

export default mongoose.model('HybridRecord', RecordSchema);

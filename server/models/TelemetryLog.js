import mongoose from 'mongoose';

const TelemetryLogSchema = new mongoose.Schema({
  logId: { type: String, required: true, unique: true },
  timestamp: { type: Number, required: true },
  patientName: { type: String, default: 'Paciente Prueba' },
  t_iot: { type: Number, default: null },
  isBleConnected: { type: Boolean, default: false },
  t_ai: { type: Number, default: null },          // null = sin métrica real (no se inventa)
  t_db_hash: { type: Number, required: true },
  t_ui: { type: Number, default: null },
  t_blockchain: { type: Number, default: null },
  t_hash_ms: { type: Number, default: null },     // SHA-256 en el servidor (ms); null en registros previos
  t_firma_ms: { type: Number, default: null },    // Firma ECDSA del relayer (ms); null en registros previos
  // Costos por triage: null si no hay dato real (sin relleno). wei y POL como texto decimal exacto
  gas_used: { type: Number, default: null },                  // receipt.gasUsed (unidades de gas)
  effective_gas_price_wei: { type: String, default: null },   // receipt.effectiveGasPrice (wei)
  cost_pol: { type: String, default: null },                  // gasUsed × effectiveGasPrice, en POL
  ai_tokens_in: { type: Number, default: null },              // usageMetadata.promptTokenCount
  ai_tokens_out: { type: Number, default: null },             // candidatesTokenCount + thoughtsTokenCount
  ai_models_tried: { type: Number, default: null },           // modelos de la cascada probados hasta responder
  isRealMeasurement: { type: Boolean, default: true },
  errorReason: { type: String, default: '' }
}, { timestamps: true });

TelemetryLogSchema.index({ timestamp: -1 });

export default mongoose.model('TelemetryLog', TelemetryLogSchema);

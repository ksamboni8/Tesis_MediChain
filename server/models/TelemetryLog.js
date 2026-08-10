import mongoose from 'mongoose';

const TelemetryLogSchema = new mongoose.Schema({
  logId: { type: String, required: true, unique: true },
  timestamp: { type: Number, required: true },
  patientName: { type: String, default: 'Paciente Prueba' },
  t_iot: { type: Number, default: null },
  isBleConnected: { type: Boolean, default: false },
  t_ai: { type: Number, required: true },
  t_db_hash: { type: Number, required: true },
  t_ui: { type: Number, required: true },
  t_blockchain: { type: Number, required: true },
  isRealMeasurement: { type: Boolean, default: true },
  errorReason: { type: String, default: '' }
}, { timestamps: true });

TelemetryLogSchema.index({ timestamp: -1 });

export default mongoose.model('TelemetryLog', TelemetryLogSchema);

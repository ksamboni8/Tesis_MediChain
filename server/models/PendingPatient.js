import mongoose from 'mongoose';

const PendingPatientSchema = new mongoose.Schema({
  cedula: { type: String, required: true },
  name: { type: String, required: true },
  age: { type: Number, required: true },
  gender: { type: String, required: true, enum: ['M', 'F', 'O'] },
  eps: { type: String, default: '' },
  admissionTimestamp: { type: Number, default: Date.now }
});

export default mongoose.model('PendingPatient', PendingPatientSchema);

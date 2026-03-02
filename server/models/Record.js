const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
  // Metadata for the hybrid system
  blockchainHash: { type: String, required: true },
  blockchainSignature: { type: String, required: true },
  transactionHash: { type: String, required: false }, // Stores the PolygonScan TX link
  
  // The Patient Data Structure
  patientData: {
    id: String,
    cedula: String,
    name: String,
    age: Number,
    gender: String,
    symptoms: String,
    vitals: {
      heartRate: Number,
      spo2: Number,
      temperature: Number,
      respiratoryRate: Number,
      bloodPressureSys: Number,
      bloodPressureDia: Number,
      painLevel: Number
    },
    // ESI Algorithm Data
    checklist: {
      cardiacArrest: Boolean,
      airwayCompromise: Boolean,
      severeRespiratoryDistress: Boolean,
      shockSigns: Boolean,
      unresponsive: Boolean,
      confusedLethargic: Boolean,
      severePainDistress: Boolean,
      highRiskCondition: Boolean
    },
    selectedResources: [String],
    resourcesCount: Number,
    
    suggestedEsiLevel: Number,
    finalEsiLevel: Number,
    overrideReason: String,
    
    triageTimestamp: Number,
    estimatedAttentionTime: Number,
    attentionTimestamp: Number, // When doctor actually saw patient

    // Correction Logic
    parentRecordHash: String, // Link to previous version
    correctionReason: String,

    doctorId: String
  }
}, { timestamps: true });

module.exports = mongoose.model('HybridRecord', RecordSchema);
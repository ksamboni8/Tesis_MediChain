
import type { PatientData } from '../types';

/**
 * Crypto Service
 * Handles SHA-256 hashing for data integrity.
 */

export const generateHash = async (data: PatientData): Promise<string> => {
  // We must ensure deterministic key ordering for JSON stringify to always produce same hash
  // Explicitly constructing nested objects prevents property reordering by DBs
  
  const sortedVitals = {
    heartRate: data.vitals.heartRate,
    spo2: data.vitals.spo2,
    temperature: data.vitals.temperature,
    respiratoryRate: data.vitals.respiratoryRate,
    bloodPressureSys: data.vitals.bloodPressureSys,
    bloodPressureDia: data.vitals.bloodPressureDia,
    painLevel: data.vitals.painLevel
  };

  const sortedChecklist = {
    cardiacArrest: data.checklist.cardiacArrest,
    airwayCompromise: data.checklist.airwayCompromise,
    severeRespiratoryDistress: data.checklist.severeRespiratoryDistress,
    shockSigns: data.checklist.shockSigns,
    unresponsive: data.checklist.unresponsive,
    confusedLethargic: data.checklist.confusedLethargic,
    severePainDistress: data.checklist.severePainDistress,
    highRiskCondition: data.checklist.highRiskCondition
  };

  const payloadToHash = {
    cedula: data.cedula,
    name: data.name,
    age: data.age,
    gender: data.gender,
    symptoms: data.symptoms,
    vitals: sortedVitals, // Use sorted
    
    // Critical ESI Decisions for Traceability
    checklist: sortedChecklist, // Use sorted
    resourcesCount: data.resourcesCount,
    suggestedEsiLevel: data.suggestedEsiLevel,
    finalEsiLevel: data.finalEsiLevel,
    overrideReason: data.overrideReason || "AUTO", // Ensure defined string
    
    // Correction Linkage (Critical for Audit)
    parentRecordHash: data.parentRecordHash || "GENESIS",
    correctionReason: data.correctionReason || "NONE",

    triageTimestamp: data.triageTimestamp,
    estimatedAttentionTime: data.estimatedAttentionTime,
    doctorId: data.doctorId
  };

  const jsonString = JSON.stringify(payloadToHash);
  const msgBuffer = new TextEncoder().encode(jsonString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
};

// Seamless signing function (No popup logic, acts as a Session Key or Relayer)
export const signTransaction = async (walletAddress: string, hash: string): Promise<string> => {
  return `ECDSA_SIG_${walletAddress.substring(0,6)}_${hash.substring(0,10)}`;
};

export const verifyDataIntegrity = async (currentData: PatientData, originalBlockchainHash: string): Promise<boolean> => {
  const currentHash = await generateHash(currentData);
  return currentHash === originalBlockchainHash;
};

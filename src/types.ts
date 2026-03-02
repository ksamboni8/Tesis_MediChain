
// Usamos 'as const' para simular enums de forma compatible con JS moderno
export const UserRole = {
  DOCTOR: 'DOCTOR',
  AUDITOR: 'AUDITOR',
  ADMIN: 'ADMIN', // Simulates the System Designer / DB Admin
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
  painLevel: number; // 0-10
}

export interface ESIChecklist {
  // ESI 1 Criteria
  cardiacArrest: boolean;
  airwayCompromise: boolean;
  severeRespiratoryDistress: boolean;
  shockSigns: boolean;
  unresponsive: boolean; // Glasgow < 8
  
  // ESI 2 Criteria
  confusedLethargic: boolean;
  severePainDistress: boolean; // Derived from pain > 7 usually, but can be manual
  highRiskCondition: boolean; // Stroke, Sepsis, etc.
}

// The raw data stored in MongoDB (Off-chain)
export interface PatientData {
  id: string; // Internal UUID
  cedula: string; // Government ID
  name: string;
  age: number;
  gender: 'M' | 'F' | 'O';
  symptoms: string;
  vitals: VitalSigns;
  
  // ESI Specifics
  checklist: ESIChecklist;
  selectedResources: string[]; // List of resources selected
  resourcesCount: number;
  
  suggestedEsiLevel: ESILevel; // Calculated by Algo
  finalEsiLevel: ESILevel; // Selected by Doctor
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

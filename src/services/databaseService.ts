
import type { HybridRecord, PatientData } from '../types';
import { generateHash } from './cryptoService';

/**
 * DATABASE SERVICE (REAL API IMPLEMENTATION)
 * Connects to the Node.js/Express Backend running on port 3001.
 */

const API_URL = '/api';

export const dbService = {
  // POST: Send data to the Real MongoDB via Backend
  async insertRecord(patientData: PatientData, doctorWallet: string, txHash: string): Promise<HybridRecord> {
    
    // Generate the hash locally to send to DB for reference
    const dataHash = await generateHash(patientData);
    
    // In a real scenario, the signature comes from the wallet. 
    // Here we generate a placeholder or use the wallet signature if available.
    const signature = `SIG_${doctorWallet}_${Date.now()}`;

    const payload = {
      patientData,
      blockchainHash: dataHash,
      blockchainSignature: signature,
      transactionHash: txHash // Save the Polygon Receipt
    };

    try {
      const response = await fetch(`${API_URL}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error('Failed to save to MongoDB');
      
      const savedRecord = await response.json();
      return savedRecord;
    } catch (error) {
      console.error("DB Error:", error);
      throw error;
    }
  },

  // GET: Fetch real data from MongoDB
  async getAllRecords(): Promise<HybridRecord[]> {
    try {
      const response = await fetch(`${API_URL}/records`);
      if (!response.ok) throw new Error('Failed to fetch records');
      const data = await response.json();
      return data;
    } catch (error) {
      console.error("DB Error:", error);
      return [];
    }
  },

  // PATCH: Mark patient as attended (Audit Metric)
  async markAsAttended(mongoId: string): Promise<HybridRecord> {
    try {
      const response = await fetch(`${API_URL}/records/${mongoId}/attend`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attentionTimestamp: Date.now() })
      });

      if (!response.ok) throw new Error('Failed to mark as attended');
      return await response.json();
    } catch (error) {
      console.error("DB Error:", error);
      throw error;
    }
  },

  // PATCH: Execute the Hack via API
  async directHackUpdate(mongoId: string, newData: Partial<PatientData>): Promise<void> {
    try {
      const response = await fetch(`${API_URL}/hack/${mongoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newData)
      });

      if (!response.ok) throw new Error('Hack injection failed');
    } catch (error) {
      console.error("Hack Error:", error);
      throw error;
    }
  }
};

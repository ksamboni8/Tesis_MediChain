
import type { HybridRecord, PatientData } from '../types';

/**
 * DATABASE SERVICE (REAL API IMPLEMENTATION)
 * Connects to the Node.js/Express Backend running on port 3001.
 */

const API_URL = '/api';

export const dbService = {
  // POST: Send data to the backend for automatic relayer signing and Polygon Amoy registration
  async insertRecordInvisible(patientData: PatientData, doctorWallet: string): Promise<HybridRecord> {
    try {
      const response = await fetch(`${API_URL}/records/invisible`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientData, doctorWallet })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.details || errData.error || 'Failed to sign/register invisibly via backend');
      }

      const savedRecord = await response.json();
      return savedRecord;
    } catch (error) {
      console.error("DB Invisible Signing Error:", error);
      throw error;
    }
  },

  // GET: Fetch real data from MongoDB
  async getAllRecords(): Promise<HybridRecord[]> {
    try {
      const response = await fetch(`${API_URL}/records`);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || errData.details || errData.error || 'Failed to fetch records');
      }
      const data = await response.json();
      return data;
    } catch (error) {
      console.error("DB Error:", error);
      throw error;
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

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || errData.details || errData.error || 'Failed to mark as attended');
      }
      return await response.json();
    } catch (error) {
      console.error("DB Error:", error);
      throw error;
    }
  },

  // PATCH: Execute the Hack via API
  async directHackUpdate(mongoId: string, newData: Partial<PatientData>, adminWallet: string): Promise<void> {
    try {
      const response = await fetch(`${API_URL}/hack/${mongoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newData, adminWallet })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || errData.details || errData.error || 'Hack injection failed');
      }
    } catch (error) {
      console.error("Hack Error:", error);
      throw error;
    }
  },

  // ADMISSION METHODS
  async addPendingPatient(data: { cedula: string, name: string, age: number, gender: 'M' | 'F' | 'O', eps: string }) {
    const response = await fetch(`${API_URL}/pending-patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || errData.details || errData.error || 'Failed to add pending patient');
    }
    return await response.json();
  },

  async getPendingPatients() {
    const response = await fetch(`${API_URL}/pending-patients`);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || errData.details || errData.error || 'Failed to fetch waiting list');
    }
    return await response.json();
  },

  async removePendingPatient(id: string) {
    const response = await fetch(`${API_URL}/pending-patients/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || errData.details || errData.error || 'Failed to remove patient from list');
    }
  }
};

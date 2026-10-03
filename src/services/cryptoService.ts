
import type { PatientData } from '../types';
import { serializeForHash } from '../shared/hashPayload';

/**
 * Crypto Service
 * Handles SHA-256 hashing for data integrity.
 */

// SHA-256 (Web Crypto) del registro. Los campos incluidos y la serialización vienen de
// shared/hashPayload.ts, la misma definición que usa el servidor para el hash anclado en Polygon.
export const generateHash = async (data: PatientData): Promise<string> => {
  const jsonString = serializeForHash(data);
  const msgBuffer = new TextEncoder().encode(jsonString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
};

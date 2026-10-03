/**
 * Regla de verificación de integridad de la auditoría. La usan AuditList (navegador) y la prueba de
 * integridad (tests/integrity-attack.test.mts), para que ambos clasifiquen igual.
 *
 * Un registro es VALIDO solo si la transacción que tiene guardada (transactionHash) es una llamada
 * exitosa a registerTriage en el contrato y ancló exactamente el hash recalculado de su contenido.
 * Así no basta con que el contenido coincida con cualquier hash anclado: copiar en un registro el
 * contenido de otro registro anclado también se detecta.
 *
 * Además se listan los hashes anclados que no corresponden a ningún registro VALIDO: los que coinciden
 * con el hash guardado de un registro ya marcado como alterado, y los que no tienen ningún registro
 * (posible eliminación).
 */
import { ethers } from 'ethers';
import { CONTRACT_ABI, CONTRACT_ADDRESS } from '../config/contract';

export type IntegrityStatus = 'VALIDO' | 'ALTERADO' | 'NO_VERIFICADO';

export type IntegrityReason =
  | 'OK'
  | 'SIN_CADENA'        // No se pudo leer el contrato completo
  | 'TX_NO_CONSULTADA'  // No se pudo consultar la transacción del registro
  | 'TX_DUPLICADA'      // Otro registro declara la misma transacción
  | 'TX_INVALIDA'       // Sin transacción, inexistente, fallida o que no es registerTriage en el contrato
  | 'OTRA_TRANSACCION'  // El contenido coincide con un hash anclado, pero no con el de su transacción
  | 'NO_ANCLADO';       // El contenido no coincide con ningún hash anclado

export const REASON_TEXT: Record<IntegrityReason, string> = {
  OK: 'El hash recalculado coincide con el anclado en la transacción del registro.',
  SIN_CADENA: 'No se pudo leer el contrato completo; no se puede verificar.',
  TX_NO_CONSULTADA: 'No se pudo consultar la transacción del registro en Polygon Amoy.',
  TX_DUPLICADA: 'Otro registro declara la misma transacción de anclaje: hay un registro copiado.',
  TX_INVALIDA: 'La transacción guardada no existe, falló o no es un anclaje en el contrato de MediChain.',
  OTRA_TRANSACCION: 'El contenido coincide con el de otro registro anclado, no con el de su propia transacción.',
  NO_ANCLADO: 'El hash actual no está anclado en la blockchain: los datos han sido alterados.',
};

export type AnchorTx = { status: 'OK'; dataHash: string } | { status: 'NOT_FOUND' } | { status: 'NOT_ANCHOR' };

const iface = new ethers.Interface(CONTRACT_ABI as any);

// Lee una transacción y devuelve el dataHash que ancló. Lanza error solo si no se pudo consultar la red.
export async function readAnchorTx(provider: ethers.Provider, txHash: string): Promise<AnchorTx> {
  if (!ethers.isHexString(txHash, 32)) return { status: 'NOT_FOUND' };
  const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
  if (!tx || !receipt) return { status: 'NOT_FOUND' };
  if (receipt.status !== 1 || tx.to?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) return { status: 'NOT_ANCHOR' };
  let parsed: ethers.TransactionDescription | null = null;
  try { parsed = iface.parseTransaction({ data: tx.data, value: tx.value }); } catch { parsed = null; }
  if (!parsed || parsed.name !== 'registerTriage') return { status: 'NOT_ANCHOR' };
  return { status: 'OK', dataHash: String(parsed.args[1]).toLowerCase() };
}

export interface AuditInput {
  id: string;
  recomputedHash: string;          // Hash recalculado a partir de los datos actuales
  transactionHash?: string | null; // Transacción guardada en el registro
  storedHash?: string | null;      // blockchainHash guardado (solo para relacionar hashes huérfanos)
}

export interface Verdict { status: IntegrityStatus; reason: IntegrityReason }

/**
 * @param anchored  hashes anclados en el contrato (en minúsculas), o null si no se pudieron leer todos
 * @param txs       transactionHash (minúsculas) → resultado de readAnchorTx, o null si la consulta falló
 */
export function classifyRecords(
  records: AuditInput[],
  anchored: Set<string> | null,
  txs: Map<string, AnchorTx | null>
): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const txCount = new Map<string, number>();
  for (const r of records) {
    const tx = r.transactionHash?.toLowerCase();
    if (tx) txCount.set(tx, (txCount.get(tx) ?? 0) + 1);
  }
  for (const r of records) {
    const hash = r.recomputedHash.toLowerCase();
    const txHash = r.transactionHash?.toLowerCase();
    const set = (status: IntegrityStatus, reason: IntegrityReason) => out.set(r.id, { status, reason });

    if (anchored === null) { set('NO_VERIFICADO', 'SIN_CADENA'); continue; }
    if (txHash && (txCount.get(txHash) ?? 0) > 1) { set('ALTERADO', 'TX_DUPLICADA'); continue; }
    if (!txHash) { set('ALTERADO', 'TX_INVALIDA'); continue; }
    const tx = txs.get(txHash);
    if (tx === undefined || tx === null) { set('NO_VERIFICADO', 'TX_NO_CONSULTADA'); continue; }
    if (tx.status !== 'OK') { set('ALTERADO', 'TX_INVALIDA'); continue; }
    if (tx.dataHash === hash) { set('VALIDO', 'OK'); continue; }
    set('ALTERADO', anchored.has(hash) ? 'OTRA_TRANSACCION' : 'NO_ANCLADO');
  }
  return out;
}

/**
 * Hashes anclados que no corresponden a ningún registro VALIDO.
 *  - linkedToAltered: coinciden con el blockchainHash guardado de un registro que no está VALIDO
 *    (la alteración ya se reporta en ese registro).
 *  - withoutRecord: ningún registro los reclama; el registro anclado no está en la base de datos.
 */
export function findUnlinkedAnchors<T extends { dataHash: string }>(
  chain: T[],
  records: AuditInput[],
  verdicts: Map<string, Verdict>
): { linkedToAltered: T[]; withoutRecord: T[] } {
  const covered = new Set<string>();
  const storedNotValid = new Set<string>();
  for (const r of records) {
    const v = verdicts.get(r.id);
    if (v?.status === 'VALIDO') covered.add(r.recomputedHash.toLowerCase());
    else if (r.storedHash) storedNotValid.add(r.storedHash.toLowerCase());
  }
  const linkedToAltered: T[] = [];
  const withoutRecord: T[] = [];
  for (const c of chain) {
    const h = String(c.dataHash).toLowerCase();
    if (covered.has(h)) continue;
    (storedNotValid.has(h) ? linkedToAltered : withoutRecord).push(c);
  }
  return { linkedToAltered, withoutRecord };
}

/**
 * Regla de verificación de integridad de la auditoría. La usan AuditList (navegador) y las pruebas de
 * integridad y de re-anclaje (tests/integrity-attack.test.mts, tests/reanchor-attack.test.mts), para que
 * todos clasifiquen igual.
 *
 * Un registro es VALIDO solo si la transacción que tiene guardada (transactionHash) es una llamada
 * exitosa a registerTriage en el contrato y ancló exactamente el hash recalculado de su contenido.
 * Así no basta con que el contenido coincida con cualquier hash anclado: copiar en un registro el
 * contenido de otro registro anclado también se detecta.
 *
 * Además se compara la hora del anclaje (bloque) con la hora del triage. En el flujo normal el servidor
 * ancla el registro segundos después del triage; un anclaje muy posterior indica que alguien con acceso a
 * la base de datos y a una wallet autorizada alteró el registro y ancló de nuevo su contenido (re-anclaje).
 * El anclaje original no puede borrarse: se busca entre los hashes anclados sin registro uno del mismo
 * seudónimo de paciente anclado a la hora del triage, y se reporta junto al registro.
 *
 * Por último se listan los hashes anclados que no corresponden a ningún registro VALIDO: los que
 * corresponden a un registro ya marcado como alterado, y los que no tienen ningún registro (posible
 * eliminación).
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
  | 'NO_ANCLADO'        // El contenido no coincide con ningún hash anclado
  | 'REANCLADO'         // Anclaje muy posterior al triage y existe el anclaje original sin registro
  | 'ANCLAJE_TARDIO';   // Anclaje muy alejado de la hora del triage, sin anclaje original identificado

export const REASON_TEXT: Record<IntegrityReason, string> = {
  OK: 'El hash recalculado coincide con el anclado en la transacción del registro.',
  SIN_CADENA: 'No se pudo leer el contrato completo; no se puede verificar.',
  TX_NO_CONSULTADA: 'No se pudo consultar la transacción del registro en Polygon Amoy.',
  TX_DUPLICADA: 'Otro registro declara la misma transacción de anclaje: hay un registro copiado.',
  TX_INVALIDA: 'La transacción guardada no existe, falló o no es un anclaje en el contrato de MediChain.',
  OTRA_TRANSACCION: 'El contenido coincide con el de otro registro anclado, no con el de su propia transacción.',
  NO_ANCLADO: 'El hash actual no está anclado en la blockchain: los datos han sido alterados.',
  REANCLADO: 'El registro se volvió a anclar mucho después del triage y su anclaje original, hecho a la hora del triage, no coincide con su contenido actual: fue alterado y re-anclado.',
  ANCLAJE_TARDIO: 'La transacción del registro se ancló mucho después (o antes) de la hora del triage: posible re-anclaje de un registro alterado o reloj desajustado.',
};

// En el flujo normal el anclaje ocurre segundos después del triage (en las pruebas, como máximo 3 s).
// El margen absorbe la latencia de la red y un desajuste moderado del reloj del equipo del médico.
export const MAX_ANCHOR_DELAY_MS = 10 * 60 * 1000;

/** Anclaje leído del contrato; timestamp en milisegundos (block.timestamp * 1000). */
export interface ChainAnchor {
  id: string | number;
  dataHash: string;
  patientIdAnonymized: string;
  triageLevel?: number;
  timestamp: number;
}

export type AnchorTx = { status: 'OK'; dataHash: string; pseudonym: string } | { status: 'NOT_FOUND' } | { status: 'NOT_ANCHOR' };

const iface = new ethers.Interface(CONTRACT_ABI as any);

// Lee una transacción y devuelve el dataHash y el seudónimo que ancló. Lanza error solo si no se pudo
// consultar la red.
export async function readAnchorTx(provider: ethers.Provider, txHash: string): Promise<AnchorTx> {
  if (!ethers.isHexString(txHash, 32)) return { status: 'NOT_FOUND' };
  const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
  if (!tx || !receipt) return { status: 'NOT_FOUND' };
  if (receipt.status !== 1 || tx.to?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) return { status: 'NOT_ANCHOR' };
  let parsed: ethers.TransactionDescription | null = null;
  try { parsed = iface.parseTransaction({ data: tx.data, value: tx.value }); } catch { parsed = null; }
  if (!parsed || parsed.name !== 'registerTriage') return { status: 'NOT_ANCHOR' };
  return { status: 'OK', dataHash: String(parsed.args[1]).toLowerCase(), pseudonym: String(parsed.args[0]) };
}

export interface AuditInput {
  id: string;
  recomputedHash: string;          // Hash recalculado a partir de los datos actuales
  transactionHash?: string | null; // Transacción guardada en el registro
  storedHash?: string | null;      // blockchainHash guardado (solo para relacionar hashes huérfanos)
  triageTimestamp?: number | null; // Hora del triage (ms), para compararla con la del anclaje
}

export interface Verdict {
  status: IntegrityStatus;
  reason: IntegrityReason;
  anchorDelayMin?: number;      // Minutos entre el triage y el anclaje (REANCLADO y ANCLAJE_TARDIO)
  originalAnchor?: ChainAnchor; // Anclaje original sin registro (REANCLADO)
}

/**
 * @param anchored  hashes anclados en el contrato (en minúsculas), o null si no se pudieron leer todos
 * @param txs       transactionHash (minúsculas) → resultado de readAnchorTx, o null si la consulta falló
 * @param chain     anclajes del contrato, para comparar la hora del anclaje con la del triage
 */
export function classifyRecords(
  records: AuditInput[],
  anchored: Set<string> | null,
  txs: Map<string, AnchorTx | null>,
  chain?: ChainAnchor[] | null
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
  if (anchored !== null && chain) checkAnchorTimes(records, txs, chain, out);
  return out;
}

// Re-anclaje: un registro VALIDO cuyo anclaje está a más de MAX_ANCHOR_DELAY_MS de la hora del triage.
function checkAnchorTimes(
  records: AuditInput[],
  txs: Map<string, AnchorTx | null>,
  chain: ChainAnchor[],
  out: Map<string, Verdict>
) {
  const late: { r: AuditInput; delay: number; pseudonym: string }[] = [];
  for (const r of records) {
    if (out.get(r.id)?.status !== 'VALIDO' || r.triageTimestamp == null) continue;
    const tx = txs.get(String(r.transactionHash).toLowerCase());
    if (!tx || tx.status !== 'OK') continue;
    const triage = Number(r.triageTimestamp);
    // Anclaje de su transacción: mismo hash y seudónimo (si se repite, el más cercano al triage)
    const own = chain
      .filter(c => String(c.dataHash).toLowerCase() === tx.dataHash && c.patientIdAnonymized === tx.pseudonym)
      .sort((a, b) => Math.abs(a.timestamp - triage) - Math.abs(b.timestamp - triage))[0];
    if (!own) continue;
    const delay = own.timestamp - triage;
    if (Math.abs(delay) > MAX_ANCHOR_DELAY_MS) late.push({ r, delay, pseudonym: tx.pseudonym });
  }
  if (late.length === 0) return;

  // Hashes que respaldan a los registros que siguen VALIDO
  const lateIds = new Set(late.map(l => l.r.id));
  const covered = new Set<string>();
  for (const r of records) {
    if (out.get(r.id)?.status === 'VALIDO' && !lateIds.has(r.id)) covered.add(r.recomputedHash.toLowerCase());
  }
  // Anclaje original: mismo seudónimo, a la hora del triage y sin un registro VALIDO que lo respalde
  for (const { r, delay, pseudonym } of late) {
    const triage = Number(r.triageTimestamp);
    const original = chain
      .filter(c => {
        const h = String(c.dataHash).toLowerCase();
        return c.patientIdAnonymized === pseudonym && !covered.has(h) && h !== r.recomputedHash.toLowerCase()
          && Math.abs(c.timestamp - triage) <= MAX_ANCHOR_DELAY_MS;
      })
      .sort((a, b) => Math.abs(a.timestamp - triage) - Math.abs(b.timestamp - triage))[0];
    out.set(r.id, {
      status: 'ALTERADO',
      reason: original ? 'REANCLADO' : 'ANCLAJE_TARDIO',
      anchorDelayMin: Math.round(delay / 60000),
      ...(original ? { originalAnchor: original } : {}),
    });
  }
}

/**
 * Hashes anclados que no corresponden a ningún registro VALIDO.
 *  - linkedToAltered: coinciden con el blockchainHash guardado de un registro que no está VALIDO, o son
 *    el anclaje original de un registro re-anclado (la alteración ya se reporta en ese registro).
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
    // Re-anclaje: tanto el anclaje tardío como el original se reportan en el registro
    if (v?.anchorDelayMin !== undefined) storedNotValid.add(r.recomputedHash.toLowerCase());
    if (v?.originalAnchor) storedNotValid.add(String(v.originalAnchor.dataHash).toLowerCase());
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

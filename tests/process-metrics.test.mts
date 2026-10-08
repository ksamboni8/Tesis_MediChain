// Métricas del proceso de triage con MediChain, para el contraste por etapa del Capítulo 7.
// Solo lectura: no modifica MongoDB ni envía transacciones, y no imprime datos de pacientes.
//
//  1. Calidad del registro: para cada registro de MongoDB, qué campos obligatorios faltan según la
//     misma regla que aplican el formulario y el servidor (src/shared/requiredFields.ts), y qué
//     elementos de trazabilidad conserva (nivel sugerido, explicación de la IA, justificación del
//     cambio, motivo de la corrección, médico y hora del triage).
//  2. Verificación posterior: tiempo de auditar toda la base con la regla de AuditList
//     (src/shared/anchorAudit.ts) y tiempo de verificar un registro (leer su transacción y recalcular
//     su hash). Se repite --runs veces (por defecto 3).
//
// Requisitos: MongoDB local y POLYGON_RPC_URL en .env (no requiere el servidor).
// Uso (desde la raíz del proyecto):  npx tsx tests/process-metrics.test.mts [--runs=3]
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Importación dinámica: el proyecto no declara "type": "module" (ver hash-parity.test.mts).
const { ethers } = await import('ethers');
const { generateHash } = await import('../src/services/cryptoService.ts');
const { CONTRACT_ABI, CONTRACT_ADDRESS } = await import('../src/config/contract.ts');
const { readAnchorTx, classifyRecords, findUnlinkedAnchors } = await import('../src/shared/anchorAudit.ts');
const { missingRequiredTriageFields } = await import('../src/shared/requiredFields.ts');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
})) as Record<string, string | true>;
const RUNS = Math.max(1, Number(args.runs) || 3);

const rpcUrl = process.env.POLYGON_RPC_URL;
if (!rpcUrl) throw new Error('POLYGON_RPC_URL no está configurado en .env');
const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: 80002, name: 'polygon-amoy' }, { staticNetwork: true });
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

// ---------- Registros (lectura directa de MongoDB) ----------
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/medichain_thesis';
const mongoose = (await import('mongoose')).default;
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
const records: any[] = await mongoose.connection.db!.collection('hybridrecords')
  .find({}, { projection: { patientData: 1, transactionHash: 1, blockchainHash: 1, createdAt: 1 } }).toArray();
await mongoose.disconnect();

// ---------- Auditoría completa con la regla de AuditList ----------
async function readChain() {
  const total = Number(await contract.getTotalRecords());
  const recs: any[] = total === 0 ? [] : Array.from(await contract.getLatestRecords(total));
  if (recs.length !== total) throw new Error(`Se leyeron ${recs.length} de ${total} anclajes`);
  return recs.map(r => ({
    id: Number(r.id), dataHash: String(r.dataHash).toLowerCase(), patientIdAnonymized: String(r.patientIdAnonymized),
    triageLevel: Number(r.triageLevel), timestamp: Number(r.timestamp) * 1000,
  }));
}
async function fullAudit() {
  const t0 = performance.now();
  const chain = await readChain();
  const t1 = performance.now();
  const txs = new Map<string, any>();
  const hashes = [...new Set(records.map(r => r.transactionHash).filter(Boolean).map((h: string) => h.toLowerCase()))];
  const queue = [...hashes];
  // 5 consultas en paralelo, como web3Service.getAnchorTransactions
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
      try { txs.set(h, await readAnchorTx(provider, h)); } catch { txs.set(h, null); }
    }
  }));
  const t2 = performance.now();
  const inputs = [];
  for (const r of records) {
    inputs.push({ id: String(r._id), recomputedHash: await generateHash(r.patientData), transactionHash: r.transactionHash,
      storedHash: r.blockchainHash, triageTimestamp: r.patientData?.triageTimestamp });
  }
  const t3 = performance.now();
  const verdicts = classifyRecords(inputs, new Set(chain.map(c => c.dataHash)), txs, chain);
  const unlinked = findUnlinkedAnchors(chain, inputs, verdicts);
  const t4 = performance.now();
  return {
    ms: { total: t4 - t0, readChain: t1 - t0, readTransactions: t2 - t1, recomputeHashes: t3 - t2, classify: t4 - t3 },
    anchors: chain.length, transactions: hashes.length, verdicts, unlinked,
  };
}

// ---------- Verificación de un registro: leer su transacción y recalcular su hash ----------
async function verifyOne(r: any) {
  const t0 = performance.now();
  const tx = await readAnchorTx(provider, r.transactionHash);
  const h = (await generateHash(r.patientData)).toLowerCase();
  const ok = tx.status === 'OK' && tx.dataHash === h;
  return { ms: performance.now() - t0, ok };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, min: s[0], median, mean, max: s[s.length - 1] };
};

console.log(`Registros en MongoDB: ${records.length}`);
const audits = [];
for (let i = 0; i < RUNS; i++) {
  const a = await fullAudit();
  audits.push(a);
  console.log(`Auditoría completa ${i + 1}/${RUNS}: ${(a.ms.total / 1000).toFixed(2)} s (cadena ${(a.ms.readChain / 1000).toFixed(2)} s, transacciones ${(a.ms.readTransactions / 1000).toFixed(2)} s, hashes ${a.ms.recomputeHashes.toFixed(1)} ms)`);
}
const verdicts = audits[0].verdicts;
const valid = records.filter(r => verdicts.get(String(r._id))?.status === 'VALIDO');
const byStatus: Record<string, number> = {};
verdicts.forEach(v => { byStatus[v.status] = (byStatus[v.status] ?? 0) + 1; });

const single: number[] = [];
let singleOk = 0;
for (let i = 0; i < RUNS; i++) {
  for (const r of valid) { const v = await verifyOne(r); single.push(v.ms); if (v.ok) singleOk++; }
}
console.log(`Verificación de un registro: mediana ${stats(single).median.toFixed(0)} ms (n = ${single.length}, coincidencias ${singleOk}/${single.length})`);

// ---------- Calidad del registro ----------
function quality(rs: any[]) {
  const n = rs.length;
  const count = (pred: (r: any) => boolean) => rs.filter(pred).length;
  const missingByField: Record<string, number> = {};
  for (const r of rs) for (const m of missingRequiredTriageFields(r.patientData)) missingByField[m] = (missingByField[m] ?? 0) + 1;
  const pd = (r: any) => r.patientData || {};
  // La explicación de la IA se guarda en aiExplanation desde RF-21; la versión usada en las pruebas la
  // guardaba en overrideReason con el prefijo «Clasificado por IA:». Ambos campos forman parte del hash.
  const aiExplanationOf = (r: any) => {
    if (typeof pd(r).aiExplanation === 'string' && pd(r).aiExplanation.trim() !== '') return pd(r).aiExplanation;
    const m = String(pd(r).overrideReason || '').match(/^Clasificado por IA:\s*(.+)/is);
    return m ? m[1] : null;
  };
  const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  const overridden = rs.filter(r => pd(r).suggestedEsiLevel != null && pd(r).suggestedEsiLevel !== pd(r).finalEsiLevel);
  // Clasificados con la IA: los que el sistema marcó «Clasificado por IA:» (versión de las pruebas) y, en la
  // versión actual, los que aceptaron el nivel de la IA. Los marcados «Clasificado por medico:» no cuentan,
  // aunque el nivel coincida, porque el profesional registró su propio razonamiento.
  const aiClassified = rs.filter(r => /^Clasificado por IA:/i.test(String(pd(r).overrideReason || ''))
    || (hasText(pd(r).aiExplanation) && pd(r).aiLevel != null && pd(r).aiLevel === pd(r).finalEsiLevel)
    || (pd(r).overrideReason === 'Concordancia con la sugerencia de la IA'));
  const corrections = rs.filter(r => pd(r).parentRecordHash && pd(r).parentRecordHash !== 'GENESIS');
  return {
    n,
    complete: count(r => missingRequiredTriageFields(r.patientData).length === 0),
    missingByField,
    withFinalLevel: count(r => Number.isInteger(pd(r).finalEsiLevel)),
    withSuggestedLevel: count(r => pd(r).suggestedEsiLevel != null),
    withAiExplanation: count(r => aiExplanationOf(r) !== null),
    withAiExplanationField: count(r => hasText(pd(r).aiExplanation)),
    // RF-21 se evalúa solo sobre los registros clasificados con la IA
    aiClassified: aiClassified.length,
    aiClassifiedWithExplanation: aiClassified.filter(r => aiExplanationOf(r) !== null).length,
    // Nivel final distinto del sugerido: con texto en overrideReason, y si ese texto es la explicación de la
    // IA (el médico adoptó el nivel de la IA frente al del motor de reglas retirado) o una justificación propia
    overridden: overridden.length,
    overriddenWithReason: overridden.filter(r => hasText(pd(r).overrideReason)).length,
    overriddenWithAiExplanation: overridden.filter(r => /^Clasificado por IA:/i.test(String(pd(r).overrideReason || ''))).length,
    corrections: corrections.length,
    correctionsWithReason: corrections.filter(r => typeof pd(r).correctionReason === 'string' && pd(r).correctionReason.trim() !== '').length,
    withDoctor: count(r => typeof pd(r).doctorId === 'string' && /^0x[0-9a-fA-F]{40}$/.test(pd(r).doctorId)),
    withTriageTime: count(r => Number.isFinite(pd(r).triageTimestamp)),
    withTransaction: count(r => typeof r.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.transactionHash)),
  };
}
const qAll = quality(records);
const qValid = quality(valid);
console.log(`Registros completos (todos los campos obligatorios): ${qAll.complete}/${qAll.n} en total; ${qValid.complete}/${qValid.n} entre los VALIDO`);
console.log(`RF-21: registros clasificados con la IA que guardan su explicación: ${qAll.aiClassifiedWithExplanation}/${qAll.aiClassified} (${qAll.withAiExplanationField} en aiExplanation)`);
console.log(`Nivel final distinto del sugerido: ${qAll.overridden}; con texto en overrideReason: ${qAll.overriddenWithReason} (${qAll.overriddenWithAiExplanation} con la explicación de la IA y ${qAll.overriddenWithReason - qAll.overriddenWithAiExplanation} con justificación del profesional); correcciones con motivo: ${qAll.correctionsWithReason}/${qAll.corrections}`);

// ---------- Evidencia ----------
const outDir = path.join('tests', 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(outDir, `process-metrics-${stamp}.json`);
const report = {
  date: new Date().toISOString(), contract: CONTRACT_ADDRESS, runs: RUNS,
  audit: {
    records: records.length, anchors: audits[0].anchors, transactions: audits[0].transactions, byStatus,
    anchoredWithoutRecord: audits[0].unlinked.withoutRecord.length,
    totalSeconds: stats(audits.map(a => a.ms.total / 1000)),
    phasesMs: audits.map(a => a.ms),
  },
  singleRecordVerification: { ms: stats(single), matches: singleOk, of: single.length },
  quality: { all: qAll, valid: qValid },
};
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`Evidencia: ${file}`);
process.exit(0);

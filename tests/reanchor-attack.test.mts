// Prueba de re-anclaje: ataque de quien tiene acceso de escritura a MongoDB y además controla una wallet
// autorizada en el contrato (médico u owner).
//
// Flujo:
//  1. Línea base: audita todos los registros con la misma regla que AuditList (src/shared/anchorAudit.ts)
//     y elige un registro VALIDO. Guarda el documento original completo antes de tocar nada.
//  2. Ataque:
//     a. altera finalEsiLevel directamente en MongoDB (sin pasar por la API);
//     b. calcula el hash del contenido alterado con la misma serialización que el sistema;
//     c. ancla ese hash llamando a registerTriage desde la wallet atacante, sin pasar por el servidor;
//     d. guarda en el registro el nuevo transactionHash y el nuevo blockchainHash.
//  3. Auditoría: el nuevo anclaje es válido, pero muy posterior a la hora del triage; comprueba que el
//     registro sale ALTERADO con motivo REANCLADO y que la auditoría lo relaciona con su anclaje ORIGINAL,
//     que sigue en la cadena. Reúne además la evidencia que queda en la
//     cadena: remitente del anclaje nuevo, su fecha frente a la del triage y los anclajes con el mismo
//     seudónimo de paciente.
//  4. Restaura el documento original y vuelve a auditar.
//  5. Guarda en tests/results/ el JSON y un CSV con la evidencia.
//
// Efecto permanente: la transacción del paso 2c queda en Polygon Amoy para siempre. Tras restaurar, su
// hash ya no lo reclama ningún registro y la auditoría lo seguirá mostrando como anclado sin registro.
//
// Requisitos: servidor corriendo (npm run dev), MongoDB local, POLYGON_RPC_URL en .env y saldo de prueba
// (POL de Amoy) en la wallet atacante. La wallet atacante es ATTACKER_PRIVATE_KEY si está definida; si no,
// la del Relayer, que es el owner del contrato (el contrato también acepta al owner en registerTriage).
//
// Uso (desde la raíz del proyecto):
//   npx tsx tests/reanchor-attack.test.mts                       -> solo muestra el plan (no modifica nada)
//   npx tsx tests/reanchor-attack.test.mts --yes                 -> ejecuta sobre el registro VALIDO más antiguo
//   npx tsx tests/reanchor-attack.test.mts --yes --id=<_id>      -> ejecuta sobre ese registro
//   npx tsx tests/reanchor-attack.test.mts --restore=tests/results/reanchor-XXXX.json --yes
//                                                                -> reinserta el documento original
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Importación dinámica: el proyecto no declara "type": "module" (ver hash-parity.test.mts).
const { ethers } = await import('ethers');
const { generateHash } = await import('../src/services/cryptoService.ts');
const { CONTRACT_ABI, CONTRACT_ADDRESS } = await import('../src/config/contract.ts');
const { readAnchorTx, classifyRecords, findUnlinkedAnchors } = await import('../src/shared/anchorAudit.ts');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
})) as Record<string, string | true>;

const API = String(args.api || process.env.API_BASE || 'http://localhost:3000/api');
const CONFIRMED = args.yes === true;

// ---------- Blockchain ----------
const rpcUrl = process.env.POLYGON_RPC_URL;
if (!rpcUrl) throw new Error('POLYGON_RPC_URL no está configurado en .env');
const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: 80002, name: 'polygon-amoy' }, { staticNetwork: true });
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

// Todos los anclajes del contrato, con el seudónimo del paciente y el remitente
async function readChain(): Promise<any[]> {
  const total = Number(await contract.getTotalRecords());
  if (total === 0) return [];
  let recs: any[] = Array.from(await contract.getLatestRecords(total));
  if (recs.length !== total) {
    const byIndex: any[] = [];
    for (let i = 0; i <= total; i++) {
      const r = await contract.records(i);
      if (r && r.dataHash) byIndex.push(r);
    }
    recs = byIndex;
  }
  if (recs.length !== total) throw new Error(`Se leyeron ${recs.length} de ${total} registros anclados; la verificación no sería completa.`);
  return recs.map(r => ({
    id: Number(r.id), dataHash: String(r.dataHash).toLowerCase(), patientIdAnonymized: String(r.patientIdAnonymized),
    triageLevel: Number(r.triageLevel), doctor: String(r.doctor), timestamp: Number(r.timestamp) * 1000,
  }));
}

async function readTxs(hashes: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const h of [...new Set(hashes.map(x => x.toLowerCase()))]) {
    try { out.set(h, await readAnchorTx(provider, h)); }
    catch (err: any) { console.error(`  No se pudo consultar ${h}: ${err.shortMessage || err.message}`); out.set(h, null); }
  }
  return out;
}

// ---------- API (solo lectura de registros, con sesión) ----------
let sessionToken: string | null = null;
async function getRecords(): Promise<any[]> {
  if (!sessionToken) {
    const key = process.env.ADMIN_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
    if (!key) throw new Error('Defina ADMIN_PRIVATE_KEY o RELAYER_PRIVATE_KEY en .env para iniciar sesión en la API');
    const wallet = new ethers.Wallet(key);
    const nonceRes = await fetch(`${API}/auth/nonce?address=${wallet.address}`);
    const { message, error } = await nonceRes.json();
    if (!nonceRes.ok) throw new Error(`No se pudo pedir el nonce: ${error}`);
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature: await wallet.signMessage(message) }),
    });
    const login = await loginRes.json();
    if (!loginRes.ok) throw new Error(`Inicio de sesión rechazado: ${login.error}`);
    sessionToken = login.token;
  }
  const res = await fetch(`${API}/records`, { headers: { Authorization: `Bearer ${sessionToken}` } });
  if (!res.ok) throw new Error(`GET /records respondió ${res.status}`);
  return res.json();
}

// Auditoría con la misma regla que AuditList
async function audit(records: any[]) {
  const chain = await readChain();
  const anchored = new Set(chain.map(c => c.dataHash));
  const txs = await readTxs(records.map(r => r.transactionHash).filter(Boolean));
  const inputs: any[] = [];
  for (const rec of records) {
    inputs.push({ id: rec._id, recomputedHash: await generateHash(rec.patientData), transactionHash: rec.transactionHash, storedHash: rec.blockchainHash, triageTimestamp: rec.patientData.triageTimestamp });
  }
  const verdicts = classifyRecords(inputs, anchored, txs, chain);
  const unlinked = findUnlinkedAnchors(chain, inputs, verdicts);
  return {
    chain, verdicts,
    hashOf: new Map(inputs.map(i => [i.id, i.recomputedHash])),
    withoutRecord: new Set(unlinked.withoutRecord.map(c => c.dataHash)),
    linkedToAltered: new Set(unlinked.linkedToAltered.map(c => c.dataHash)),
  };
}

// ---------- MongoDB (acceso directo del atacante) ----------
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/medichain_thesis';
async function withRecords<T>(fn: (col: any, mongo: any) => Promise<T>): Promise<T> {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try { return await fn(mongoose.connection.db!.collection('hybridrecords'), mongoose.mongo); }
  finally { await mongoose.disconnect(); }
}
async function restoreDocument(originalDocument: string) {
  await withRecords(async (col, mongo) => {
    const doc = mongo.BSON.EJSON.parse(originalDocument);
    await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
  });
}

// ---------- Modo restauración ----------
if (args.restore) {
  const report = JSON.parse(fs.readFileSync(String(args.restore), 'utf8'));
  console.log(`Restaurar ${report.recordId} desde ${args.restore}`);
  if (!CONFIRMED) { console.log('Modo simulación: agregue --yes para restaurar.'); process.exit(0); }
  await restoreDocument(report.originalDocument);
  const a = await audit(await getRecords());
  const v = a.verdicts.get(report.recordId);
  console.log(`Estado tras restaurar: ${v?.status} (${v?.reason})`);
  process.exit(v?.status === 'VALIDO' ? 0 : 1);
}

// ---------- 1. Línea base ----------
const attackerKey = process.env.ATTACKER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
if (!attackerKey) throw new Error('Defina ATTACKER_PRIVATE_KEY o RELAYER_PRIVATE_KEY en .env');
const attacker = new ethers.Wallet(attackerKey, provider);
const relayerAddress = process.env.RELAYER_PRIVATE_KEY ? new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address : null;
const [isDoctor, owner] = await Promise.all([contract.isDoctor(attacker.address), contract.owner()]);
const attackerRole = isDoctor ? 'médico registrado' : owner.toLowerCase() === attacker.address.toLowerCase() ? 'owner del contrato' : null;
if (!attackerRole) throw new Error(`La wallet ${attacker.address} no está autorizada en el contrato; registerTriage la rechazaría.`);

console.log(`API: ${API}\nContrato: ${CONTRACT_ADDRESS}\nWallet atacante: ${attacker.address} (${attackerRole}${relayerAddress && relayerAddress === attacker.address ? '; es la misma del Relayer' : ''})`);
const records0 = await getRecords();
const audit0 = await audit(records0);
const valid0 = records0.filter(r => audit0.verdicts.get(r._id)?.status === 'VALIDO');
console.log(`Línea base: ${records0.length} registros, ${audit0.chain.length} anclajes, ${valid0.length} VALIDO, ${audit0.withoutRecord.size} anclados sin registro`);

const target = typeof args.id === 'string'
  ? records0.find(r => r._id === args.id)
  : [...valid0].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
if (!target) throw new Error('No se encontró un registro VALIDO para la prueba.');
if (audit0.verdicts.get(target._id)?.status !== 'VALIDO') throw new Error(`El registro ${target._id} no está VALIDO en la línea base.`);

const originalHash = audit0.hashOf.get(target._id)!.toLowerCase();
const nextEsi = (v: number) => (Number(v) % 5) + 1;
const alteredData = { ...target.patientData, finalEsiLevel: nextEsi(target.patientData.finalEsiLevel) };
const alteredHash = (await generateHash(alteredData)).toLowerCase();

// Parámetros del anclaje original, para que el nuevo se vea igual (mismo seudónimo y metadatos)
const iface = new ethers.Interface(['function registerTriage(string _patientIdAnonymized, string _dataHash, uint8 _triageLevel, string _aiReasoningHash)']);
const originalTx = await provider.getTransaction(target.transactionHash);
const originalArgs = iface.parseTransaction({ data: originalTx!.data })!.args;
const pseudonym = String(originalArgs[0]);
const metadata = String(originalArgs[3]);

console.log(`\nPlan:`);
console.log(`  Registro: ${target._id} (triage ${new Date(target.patientData.triageTimestamp).toISOString()})`);
console.log(`  finalEsiLevel: ${target.patientData.finalEsiLevel} -> ${alteredData.finalEsiLevel} (directo en MongoDB)`);
console.log(`  Hash original anclado: ${originalHash}`);
console.log(`  Hash del contenido alterado: ${alteredHash}`);
console.log(`  Nuevo anclaje: registerTriage("${pseudonym}", hash alterado, ${alteredData.finalEsiLevel}, "${metadata}") desde ${attacker.address}`);
console.log('  Efecto permanente: el nuevo anclaje queda en Polygon Amoy y, tras restaurar, aparecerá como anclado sin registro.');
if (!CONFIRMED) {
  console.log('\nModo simulación: no se modificó nada. Agregue --yes para ejecutar la prueba.');
  process.exit(0);
}

// ---------- 2. Ataque ----------
const startedAt = new Date().toISOString();
const outDir = path.join('tests', 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = startedAt.replace(/[:.]/g, '-');
const jsonFile = path.join(outDir, `reanchor-${stamp}.json`);
const csvFile = path.join(outDir, `reanchor-${stamp}.csv`);

// Respaldo antes de tocar nada: si el script falla, se restaura con --restore
const originalDocument = await withRecords(async (col, mongo) => {
  const doc = await col.findOne({ _id: new mongo.ObjectId(target._id) });
  if (!doc) throw new Error(`No se encontró ${target._id} en MongoDB`);
  return mongo.BSON.EJSON.stringify(doc, { relaxed: false });
});
const report: any = { startedAt, api: API, contract: CONTRACT_ADDRESS, attacker: attacker.address, attackerRole, relayer: relayerAddress, recordId: target._id, originalDocument, originalHash, alteredHash };
fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
console.log(`\nRespaldo guardado en ${jsonFile}`);

try {
  // a. Alteración directa en MongoDB
  await withRecords(async (col, mongo) => {
    await col.updateOne({ _id: new mongo.ObjectId(target._id) }, { $set: { 'patientData.finalEsiLevel': alteredData.finalEsiLevel } });
  });
  console.log(`  MongoDB: finalEsiLevel alterado`);

  // c. Anclaje del hash alterado desde la wallet atacante, sin pasar por el servidor
  const signer = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, attacker);
  const tx = await signer.registerTriage(pseudonym, alteredHash, alteredData.finalEsiLevel, metadata);
  console.log(`  Polygon: transacción enviada ${tx.hash}`);
  const receipt = await tx.wait(1);
  const block = await provider.getBlock(receipt!.blockNumber);
  report.newTransactionHash = tx.hash;
  report.newTransaction = {
    status: receipt!.status, block: receipt!.blockNumber, blockTime: new Date(block!.timestamp * 1000).toISOString(),
    from: tx.from, gasUsed: receipt!.gasUsed.toString(),
  };
  console.log(`  Polygon: confirmada en el bloque ${receipt!.blockNumber}`);

  // d. El registro apunta a la nueva transacción y guarda el nuevo hash
  await withRecords(async (col, mongo) => {
    await col.updateOne({ _id: new mongo.ObjectId(target._id) }, { $set: { transactionHash: tx.hash, blockchainHash: alteredHash } });
  });
  console.log(`  MongoDB: transactionHash y blockchainHash reemplazados`);

  // ---------- 3. Auditoría tras el ataque ----------
  const audit1 = await audit(await getRecords());
  const v = audit1.verdicts.get(target._id);
  const samePseudonym = audit1.chain.filter(c => c.patientIdAnonymized === pseudonym);
  report.afterAttack = {
    recordStatus: v?.status, recordReason: v?.reason,
    // Regla de fecha (anchorAudit.ts): retraso del anclaje y anclaje original relacionado con el registro
    anchorDelayMin: v?.anchorDelayMin ?? null,
    originalAnchor: v?.originalAnchor ? { id: v.originalAnchor.id, dataHash: v.originalAnchor.dataHash, triageLevel: v.originalAnchor.triageLevel, time: new Date(v.originalAnchor.timestamp).toISOString() } : null,
    originalAnchorMatches: String(v?.originalAnchor?.dataHash ?? '').toLowerCase() === originalHash,
    originalHashWithoutRecord: audit1.withoutRecord.has(originalHash),
    anchoredWithoutRecord: audit1.withoutRecord.size,
    evidence: {
      newAnchorSender: report.newTransaction.from,
      senderIsRelayer: relayerAddress ? report.newTransaction.from.toLowerCase() === relayerAddress.toLowerCase() : null,
      triageTime: new Date(target.patientData.triageTimestamp).toISOString(),
      newAnchorTime: report.newTransaction.blockTime,
      anchorDelayMinutes: Math.round((Date.parse(report.newTransaction.blockTime) - target.patientData.triageTimestamp) / 60000),
      anchorsWithSamePseudonym: samePseudonym.map(c => ({ id: c.id, dataHash: c.dataHash, time: new Date(c.timestamp).toISOString() })),
    },
  };
} finally {
  // ---------- 4. Restauración ----------
  await restoreDocument(originalDocument);
  console.log(`  MongoDB: documento original restaurado`);
}

const audit2 = await audit(await getRecords());
const v2 = audit2.verdicts.get(target._id);
report.afterRestore = {
  recordStatus: v2?.status, recordReason: v2?.reason,
  newHashWithoutRecord: audit2.withoutRecord.has(alteredHash),
  anchoredWithoutRecord: audit2.withoutRecord.size,
};
report.finishedAt = new Date().toISOString();

const a = report.afterAttack;
console.log('\nResultados tras el ataque:');
console.log(`  Estado del registro alterado: ${a.recordStatus} (${a.recordReason})`);
console.log(`  Retraso del anclaje según la auditoría: ${a.anchorDelayMin} min`);
console.log(`  Anclaje original relacionado con el registro: ${a.originalAnchor ? `#${a.originalAnchor.id} (nivel ${a.originalAnchor.triageLevel}, ${a.originalAnchor.time})` : 'no'}${a.originalAnchorMatches ? ', coincide con el hash original' : ''}`);
console.log(`  Hash original en la alerta genérica de anclados sin registro: ${a.originalHashWithoutRecord ? 'sí' : 'no'}`);
console.log(`  Remitente del nuevo anclaje: ${a.evidence.newAnchorSender}${a.evidence.senderIsRelayer ? ' (la misma wallet del Relayer)' : ''}`);
console.log(`  Anclaje nuevo ${a.evidence.anchorDelayMinutes} min después de la hora del triage`);
console.log(`  Anclajes con el mismo seudónimo: ${a.evidence.anchorsWithSamePseudonym.length}`);
console.log('Tras restaurar:');
console.log(`  Estado del registro: ${report.afterRestore.recordStatus}`);
console.log(`  Hash del anclaje del ataque, ahora sin registro: ${report.afterRestore.newHashWithoutRecord ? 'sí' : 'no'} (queda de forma permanente)`);

fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2));
const csvEsc = (x: unknown) => `"${String(typeof x === 'string' ? x : JSON.stringify(x)).replace(/"/g, '""')}"`;
fs.writeFileSync(csvFile, [
  ['recordId', 'campo', 'antes', 'despues', 'hashOriginal', 'hashAlterado', 'txAtaque', 'remitente', 'estadoTrasAtaque', 'motivoTrasAtaque', 'retrasoMin', 'anclajeOriginal', 'anclajeOriginalCoincide', 'hashOriginalEnAlertaGenerica', 'anclajesMismoSeudonimo', 'estadoTrasRestaurar'].join(','),
  [target._id, 'finalEsiLevel', target.patientData.finalEsiLevel, alteredData.finalEsiLevel, originalHash, alteredHash, report.newTransactionHash,
   a.evidence.newAnchorSender, a.recordStatus, a.recordReason, a.anchorDelayMin, a.originalAnchor ? `#${a.originalAnchor.id}` : '', a.originalAnchorMatches,
   a.originalHashWithoutRecord, a.evidence.anchorsWithSamePseudonym.length, report.afterRestore.recordStatus].map(csvEsc).join(','),
].join('\n'));
console.log(`\nEvidencia: ${jsonFile}\n           ${csvFile}`);

// La prueba pasa si la auditoría marca el registro re-anclado como ALTERADO (REANCLADO), lo relaciona con
// su anclaje original (el hash anclado a la hora del triage) y el registro vuelve a VALIDO al restaurar.
process.exit(a.recordStatus === 'ALTERADO' && a.recordReason === 'REANCLADO' && a.originalAnchorMatches && report.afterRestore.recordStatus === 'VALIDO' ? 0 : 1);

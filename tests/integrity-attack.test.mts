// Prueba de integridad (detección de alteraciones) contra el endpoint real PATCH /api/hack/:id.
//
// Flujo:
//  1. Línea base: lee TODOS los hashes anclados en el contrato (Polygon Amoy), los registros de
//     GET /api/records y la transacción de anclaje de cada uno; clasifica con la misma regla que
//     AuditList (src/shared/anchorAudit.ts): VALIDO si su transacción ancló su hash recalculado.
//  2. Toma N registros VALIDO y, por cada uno, altera UN campo que forma parte del hash, vía el endpoint.
//     Con --extended, además: reemplaza el contenido de un registro por el de otro registro anclado
//     (vía el endpoint) y elimina otro registro directamente en MongoDB.
//  3. Confirma que cada alteración quedó realmente guardada (alteración efectiva).
//  4. Vuelve a auditar: una alteración se detecta si el registro pasa a ALTERADO; una eliminación, si su
//     hash anclado aparece como anclado sin registro. Los registros no tocados deben seguir VALIDO.
//  5. Guarda en tests/results/ el JSON completo (incluye los datos originales) y un CSV.
//
// Requisitos: servidor corriendo (npm run dev), MongoDB local, POLYGON_RPC_URL y
// ENABLE_ATTACK_SIMULATION=true en .env, y NODE_ENV
// distinto de production. attentionTimestamp y aiModelUsed no forman parte del hash y no se alteran aquí.
//
// Uso (desde la raíz del proyecto):
//   npx tsx tests/integrity-attack.test.mts                    -> solo muestra el plan (no modifica nada)
//   npx tsx tests/integrity-attack.test.mts --yes --n=10       -> ejecuta la prueba sobre 10 registros
//   npx tsx tests/integrity-attack.test.mts --yes --ids=a,b,c  -> ejecuta sobre esos _id
//   npx tsx tests/integrity-attack.test.mts --yes --n=12 --extended
//                                                              -> agrega reemplazo y eliminación
//   npx tsx tests/integrity-attack.test.mts --restore=tests/results/integrity-XXXX.json --yes
//                                                              -> restaura los valores originales
// Opcionales: --api=http://localhost:3000/api   ADMIN_PRIVATE_KEY=0x... en .env (por defecto se inicia
// sesión con la wallet del Relayer, que debe ser el owner del contrato)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Importación dinámica: el proyecto no declara "type": "module" (ver hash-parity.test.mts).
const { ethers } = await import('ethers');
const { generateHash } = await import('../src/services/cryptoService.ts');
const { CONTRACT_ABI, CONTRACT_ADDRESS } = await import('../src/config/contract.ts');
const { readAnchorTx, classifyRecords, findUnlinkedAnchors } = await import('../src/shared/anchorAudit.ts');

type Status = 'VALIDO' | 'ALTERADO' | 'NO_VERIFICADO';
type Mutation = { field: string; before: unknown; after: unknown; body: Record<string, unknown> };

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
})) as Record<string, string | true>;

const API = String(args.api || process.env.API_BASE || 'http://localhost:3000/api');
const CONFIRMED = args.yes === true;

// ---------- Blockchain: misma lectura completa que web3Service.getAllAnchoredRecords ----------
const rpcUrl = process.env.POLYGON_RPC_URL;
if (!rpcUrl) throw new Error('POLYGON_RPC_URL no está configurado en .env');
const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: 80002, name: 'polygon-amoy' }, { staticNetwork: true });
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

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
  if (recs.length !== total) {
    throw new Error(`Se leyeron ${recs.length} de ${total} registros anclados; la verificación no sería completa.`);
  }
  return recs.map(r => ({
    id: Number(r.id), dataHash: String(r.dataHash).toLowerCase(), patientIdAnonymized: String(r.patientIdAnonymized),
    triageLevel: Number(r.triageLevel), timestamp: Number(r.timestamp) * 1000,
  }));
}

// Transacciones de anclaje (readAnchorTx), con caché: una transacción confirmada no cambia.
const txCache = new Map<string, any>();
async function readTxs(hashes: string[]): Promise<Map<string, any>> {
  const pending = [...new Set(hashes.map(h => h.toLowerCase()))];
  const out = new Map<string, any>();
  const worker = async () => {
    for (let h = pending.shift(); h !== undefined; h = pending.shift()) {
      if (txCache.has(h)) { out.set(h, txCache.get(h)); continue; }
      try { const r = await readAnchorTx(provider, h); txCache.set(h, r); out.set(h, r); }
      catch (err: any) { console.error(`  No se pudo consultar ${h}: ${err.shortMessage || err.message}`); out.set(h, null); }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return out;
}

// ---------- API ----------
// La API exige una sesión (server/auth.ts). El script inicia sesión firmando el mensaje con la wallet
// de ADMIN_PRIVATE_KEY o, si no está, con la del Relayer; esa cuenta debe ser el owner del contrato
// para poder usar la ruta de simulación.
let sessionToken: string | null = null;
async function authHeaders(): Promise<Record<string, string>> {
  if (!sessionToken) {
    const key = process.env.ADMIN_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
    if (!key) throw new Error('Defina ADMIN_PRIVATE_KEY o RELAYER_PRIVATE_KEY en .env para iniciar sesión en la API');
    const wallet = new ethers.Wallet(key);
    const nonceRes = await fetch(`${API}/auth/nonce?address=${wallet.address}`);
    const { message, error } = await nonceRes.json();
    if (!nonceRes.ok) throw new Error(`No se pudo pedir el nonce: ${error}`);
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: wallet.address, signature: await wallet.signMessage(message) }),
    });
    const login = await loginRes.json();
    if (!loginRes.ok) throw new Error(`Inicio de sesión rechazado: ${login.error}`);
    if (!login.roles.includes('ADMIN')) throw new Error(`La cuenta ${wallet.address} no es el owner del contrato (roles: ${login.roles.join(', ')})`);
    sessionToken = login.token;
  }
  return { Authorization: `Bearer ${sessionToken}` };
}

async function getRecords(): Promise<any[]> {
  const res = await fetch(`${API}/records`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`GET /records respondió ${res.status}`);
  return res.json();
}

async function hack(id: string, body: Record<string, unknown>, adminWallet: string) {
  const res = await fetch(`${API}/hack/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ ...body, adminWallet }),
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

// Estado de integridad con la misma regla que AuditList (src/shared/anchorAudit.ts): cada registro se
// verifica contra su propia transacción, y se listan los hashes anclados sin registro válido.
async function audit(records: any[]) {
  const chain = await readChain();
  const anchored = new Set(chain.map(c => c.dataHash));
  const txs = await readTxs(records.map(r => r.transactionHash).filter(Boolean));
  const inputs: any[] = [];
  for (const rec of records) {
    inputs.push({ id: rec._id, recomputedHash: await generateHash(rec.patientData), transactionHash: rec.transactionHash, storedHash: rec.blockchainHash, triageTimestamp: rec.patientData.triageTimestamp });
  }
  const verdicts = classifyRecords(inputs, anchored, txs, chain);
  const status = new Map<string, { hash: string; status: Status; reason: string }>();
  for (const i of inputs) {
    const v = verdicts.get(i.id)!;
    status.set(i.id, { hash: i.recomputedHash, status: v.status as Status, reason: v.reason });
  }
  const unlinked = findUnlinkedAnchors(chain, inputs, verdicts);
  return { status, anchoredCount: anchored.size, withoutRecord: new Set(unlinked.withoutRecord.map(c => c.dataHash)) };
}

// Acceso directo a MongoDB, solo para el escenario de eliminación (--extended): quien tiene acceso a la
// base de datos puede borrar un documento sin pasar por la API.
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/medichain_thesis';
async function withRecords<T>(fn: (col: any, mongo: any) => Promise<T>): Promise<T> {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try { return await fn(mongoose.connection.db!.collection('hybridrecords'), mongoose.mongo); }
  finally { await mongoose.disconnect(); }
}

// Comparación independiente del orden de claves, para confirmar que el valor quedó guardado.
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
};

// ---------- Catálogo de alteraciones (solo campos incluidos en shared/hashPayload.ts) ----------
// Cada una produce un valor distinto del original y válido para el esquema de Record.js
// (si no, Mongoose rechaza el guardado y no habría alteración que detectar).
const nextEsi = (v: number) => (Number(v) % 5) + 1;
const MUTATIONS: Array<(pd: any) => Mutation> = [
  pd => ({ field: 'finalEsiLevel', before: pd.finalEsiLevel, after: nextEsi(pd.finalEsiLevel), body: { finalEsiLevel: nextEsi(pd.finalEsiLevel) } }),
  pd => {
    const vitals = { ...pd.vitals, spo2: pd.vitals.spo2 > 80 ? pd.vitals.spo2 - 10 : pd.vitals.spo2 + 10 };
    return { field: 'vitals.spo2', before: pd.vitals.spo2, after: vitals.spo2, body: { vitals } };
  },
  pd => ({ field: 'name', before: pd.name, after: `${pd.name} X`, body: { name: `${pd.name} X` } }),
  pd => {
    const vitals = { ...pd.vitals, heartRate: pd.vitals.heartRate + 20 };
    return { field: 'vitals.heartRate', before: pd.vitals.heartRate, after: vitals.heartRate, body: { vitals } };
  },
  pd => ({ field: 'suggestedEsiLevel', before: pd.suggestedEsiLevel, after: nextEsi(pd.suggestedEsiLevel), body: { suggestedEsiLevel: nextEsi(pd.suggestedEsiLevel) } }),
  pd => ({ field: 'symptoms', before: pd.symptoms, after: `${pd.symptoms}.`, body: { symptoms: `${pd.symptoms}.` } }),
  pd => {
    const m = pd.glasgow.motorResponse > 1 ? pd.glasgow.motorResponse - 1 : pd.glasgow.motorResponse + 1;
    const glasgow = { ...pd.glasgow, motorResponse: m, total: pd.glasgow.eyeOpening + pd.glasgow.verbalResponse + m };
    return { field: 'glasgow.motorResponse', before: pd.glasgow.motorResponse, after: m, body: { glasgow } };
  },
  pd => {
    const after = [...(pd.selectedSymptoms || []), 'Modifier: Inyectado'];
    return { field: 'selectedSymptoms', before: pd.selectedSymptoms, after, body: { selectedSymptoms: after } };
  },
  pd => ({ field: 'age', before: pd.age, after: pd.age + 1, body: { age: pd.age + 1 } }),
  pd => {
    const after = String(pd.cedula).slice(0, -1) + ((Number(String(pd.cedula).slice(-1)) + 1) % 10 || 0);
    return { field: 'cedula', before: pd.cedula, after, body: { cedula: after } };
  },
  pd => {
    const after = '0x000000000000000000000000000000000000dEaD';
    return { field: 'doctorId', before: pd.doctorId, after, body: { doctorId: after } };
  },
  pd => ({ field: 'triageTimestamp', before: pd.triageTimestamp, after: pd.triageTimestamp + 60000, body: { triageTimestamp: pd.triageTimestamp + 60000 } }),
];

// Lee el valor guardado en una ruta "a.b".
const getPath = (obj: any, p: string) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

// Dirección que se registra en la evidencia como cuenta administradora (la sesión es la que autoriza)
async function resolveAdminWallet(): Promise<string> {
  const key = process.env.ADMIN_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;
  if (key) return new ethers.Wallet(key).address;
  return String(await contract.owner());
}

// ---------- Modo restauración ----------
if (args.restore) {
  const file = String(args.restore);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const targets = report.results.filter((r: any) => r.httpStatus === 200);
  console.log(`Restaurar ${targets.length} registros desde ${file}`);
  if (!CONFIRMED) { console.log('Modo simulación: agregue --yes para restaurar.'); process.exit(0); }
  const adminWallet = await resolveAdminWallet();
  for (const r of targets) {
    if (r.kind === 'eliminacion') {
      // Se reinserta el documento original completo (mismo _id), guardado en EJSON
      await withRecords(async (col, mongo) => {
        await col.insertOne(mongo.BSON.EJSON.parse(r.originalDocument));
      });
      console.log(`  ${r.recordId}  reinsertado`);
      continue;
    }
    const res = await hack(r.recordId, r.originalPatientData, adminWallet);
    console.log(`  ${r.recordId}  HTTP ${res.status}`);
  }
  const { status } = await audit(await getRecords());
  const ok = targets.filter((r: any) => status.get(r.recordId)?.status === 'VALIDO').length;
  console.log(`Restaurados como VALIDO: ${ok}/${targets.length}`);
  process.exit(ok === targets.length ? 0 : 1);
}

// ---------- 1. Línea base ----------
console.log(`API: ${API}\nContrato: ${CONTRACT_ADDRESS}`);
const records0 = await getRecords();
const audit0 = await audit(records0);
const status0 = audit0.status;
const valid0 = records0.filter(r => status0.get(r._id)!.status === 'VALIDO');
console.log(`Línea base: ${records0.length} registros en MongoDB, ${audit0.anchoredCount} hashes anclados, ${valid0.length} VALIDO, ${records0.length - valid0.length} no válidos, ${audit0.withoutRecord.size} anclados sin registro`);

let targets: any[];
if (typeof args.ids === 'string') {
  const ids = args.ids.split(',').map(s => s.trim());
  targets = ids.map(id => records0.find(r => r._id === id) ?? (() => { throw new Error(`No existe el registro ${id}`); })());
  const notValid = targets.filter(r => status0.get(r._id)!.status !== 'VALIDO');
  if (notValid.length) throw new Error(`Estos registros no están VALIDO en la línea base: ${notValid.map(r => r._id).join(', ')}`);
} else {
  const n = Number(args.n ?? 5);
  targets = [...valid0].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, n);
}
if (targets.length === 0) throw new Error('No hay registros VALIDO para alterar.');

const plan = targets.map((rec, i) => ({ rec, mutation: MUTATIONS[i % MUTATIONS.length](rec.patientData) }));
console.log(`\nPlan (${plan.length} alteraciones):`);
for (const { rec, mutation } of plan) {
  console.log(`  ${rec._id}  ${mutation.field}: ${JSON.stringify(mutation.before)} -> ${JSON.stringify(mutation.after)}`);
}

// Escenarios adicionales (--extended), sobre registros VALIDO que no están entre los alterados:
//  - reemplazo: el contenido de "victima" se reemplaza por el de "fuente", otro registro anclado
//    ("fuente" no se modifica y sigue como control);
//  - eliminación: "eliminado" se borra directamente en MongoDB.
const EXTENDED = args.extended === true;
const spare = valid0.filter(r => !targets.some(t => t._id === r._id));
let victim: any = null, source: any = null, deleted: any = null;
if (EXTENDED) {
  if (spare.length < 3) throw new Error(`--extended necesita 3 registros VALIDO fuera de los alterados; hay ${spare.length}.`);
  [victim, deleted, source] = spare;
  console.log(`  ${victim._id}  reemplazo por el contenido de ${source._id}`);
  console.log(`  ${deleted._id}  eliminación directa en MongoDB`);
}
if (!CONFIRMED) {
  console.log('\nModo simulación: no se modificó nada. Agregue --yes para ejecutar la prueba.');
  process.exit(0);
}

// ---------- 2. Alteraciones vía endpoint ----------
const adminWallet = await resolveAdminWallet();
console.log(`\nWallet admin: ${adminWallet}`);
const startedAt = new Date().toISOString();
const results: any[] = [];
for (const { rec, mutation } of plan) {
  const res = await hack(rec._id, mutation.body, adminWallet);
  results.push({
    kind: 'campo',
    recordId: rec._id,
    patientName: rec.patientData.name,
    field: mutation.field,
    before: mutation.before,
    after: mutation.after,
    httpStatus: res.status,
    httpResponse: res.payload,
    hashBefore: status0.get(rec._id)!.hash,
    originalPatientData: rec.patientData,
  });
  console.log(`  PATCH ${rec._id} (${mutation.field})  HTTP ${res.status}`);
}

if (EXTENDED) {
  // Reemplazo: se copia todo el patientData de "fuente" en "victima" por el endpoint de simulación
  const res = await hack(victim._id, source.patientData, adminWallet);
  results.push({
    kind: 'reemplazo', recordId: victim._id, patientName: victim.patientData.name,
    field: 'patientData (completo)', before: victim.patientData.id, after: `contenido de ${source._id}`,
    httpStatus: res.status, httpResponse: res.payload, hashBefore: status0.get(victim._id)!.hash,
    // Campos que trajo la fuente y la víctima no tenía: al restaurar se ponen en null (el hash
    // normaliza null y ausente al mismo valor), para no dejar restos de la fuente
    originalPatientData: {
      ...Object.fromEntries(Object.keys(source.patientData).filter(k => !(k in victim.patientData)).map(k => [k, null])),
      ...victim.patientData,
    },
  });
  console.log(`  PATCH ${victim._id} (reemplazo)  HTTP ${res.status}`);

  // Eliminación directa en MongoDB; el documento completo se guarda en EJSON para poder reinsertarlo
  const originalDocument = await withRecords(async (col, mongo) => {
    const _id = new mongo.ObjectId(deleted._id);
    const doc = await col.findOne({ _id });
    if (!doc) throw new Error(`No se encontró ${deleted._id} en MongoDB`);
    await col.deleteOne({ _id });
    return mongo.BSON.EJSON.stringify(doc, { relaxed: false });
  });
  results.push({
    kind: 'eliminacion', recordId: deleted._id, patientName: deleted.patientData.name,
    field: 'documento completo', before: 'presente', after: 'eliminado',
    httpStatus: 200, httpResponse: { mongo: 'deleteOne' }, hashBefore: status0.get(deleted._id)!.hash,
    originalPatientData: deleted.patientData, originalDocument,
  });
  console.log(`  DELETE ${deleted._id} (MongoDB)`);
}

// ---------- 3 y 4. Verificación ----------
const records1 = await getRecords();
const audit1 = await audit(records1);
const status1 = audit1.status;
const byId = new Map(records1.map(r => [r._id, r]));

for (const r of results) {
  const stored = byId.get(r.recordId)?.patientData;
  if (r.kind === 'eliminacion') {
    // Efectiva si el registro ya no está; detectada si su hash anclado aparece como anclado sin registro
    r.effective = !byId.has(r.recordId);
    r.statusAfter = audit1.withoutRecord.has(String(r.hashBefore).toLowerCase()) ? 'ANCLADO_SIN_REGISTRO' : 'NO_REPORTADO';
    r.detected = r.statusAfter === 'ANCLADO_SIN_REGISTRO';
    continue;
  }
  if (r.kind === 'reemplazo') {
    r.storedValue = stored?.id;
    r.effective = r.httpStatus === 200 && canon(stored) === canon(source.patientData);
  } else {
    r.storedValue = getPath(stored, r.field);
    r.effective = r.httpStatus === 200 && canon(r.storedValue) === canon(r.after) && canon(r.storedValue) !== canon(r.before);
  }
  r.hashAfter = status1.get(r.recordId)?.hash;
  r.statusAfter = status1.get(r.recordId)?.status;
  r.reasonAfter = status1.get(r.recordId)?.reason;
  r.detected = r.statusAfter === 'ALTERADO';
}

const targetIds = new Set(results.map(r => r.recordId));
const controls = valid0.filter(r => !targetIds.has(r._id));
const falsePositives = controls.filter(r => status1.get(r._id)?.status !== 'VALIDO').map(r => r._id);

const effective = results.filter(r => r.effective);
const detected = effective.filter(r => r.detected);
const rate = effective.length ? (100 * detected.length) / effective.length : 0;

console.log('\nResultados:');
console.table(results.map(r => ({
  _id: r.recordId, tipo: r.kind, campo: r.field, antes: JSON.stringify(r.before), despues: JSON.stringify(r.after),
  http: r.httpStatus, efectiva: r.effective, estado: r.statusAfter, motivo: r.reasonAfter ?? '', detectada: r.detected,
})));
console.log(`Alteraciones intentadas: ${results.length}`);
console.log(`Alteraciones efectivas (HTTP 200 y valor guardado): ${effective.length}`);
console.log(`Detectadas como ALTERADO: ${detected.length}/${effective.length} (${rate.toFixed(2)} %)`);
console.log(`Controles sin alterar que siguen VALIDO: ${controls.length - falsePositives.length}/${controls.length}${falsePositives.length ? `  (falsos positivos: ${falsePositives.join(', ')})` : ''}`);

// ---------- 5. Evidencia ----------
const outDir = path.join('tests', 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = startedAt.replace(/[:.]/g, '-');
const jsonFile = path.join(outDir, `integrity-${stamp}.json`);
const csvFile = path.join(outDir, `integrity-${stamp}.csv`);
fs.writeFileSync(jsonFile, JSON.stringify({
  startedAt, finishedAt: new Date().toISOString(), api: API, contract: CONTRACT_ADDRESS, adminWallet,
  rule: 'transacción propia (src/shared/anchorAudit.ts)', extended: EXTENDED,
  baseline: { records: records0.length, anchoredHashes: audit0.anchoredCount, valid: valid0.length, anchoredWithoutRecord: audit0.withoutRecord.size },
  summary: {
    attempted: results.length, effective: effective.length, detected: detected.length, detectionRatePct: rate,
    controls: controls.length, falsePositives,
  },
  results,
}, null, 2));
const csvEsc = (v: unknown) => `"${String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/"/g, '""')}"`;
fs.writeFileSync(csvFile, [
  ['recordId', 'tipo', 'campo', 'antes', 'despues', 'http', 'efectiva', 'hashAntes', 'hashDespues', 'estadoDespues', 'motivo', 'detectada'].join(','),
  ...results.map(r => [r.recordId, r.kind, r.field, r.before, r.after, r.httpStatus, r.effective, r.hashBefore, r.hashAfter ?? '', r.statusAfter, r.reasonAfter ?? '', r.detected].map(csvEsc).join(',')),
].join('\n'));
console.log(`\nEvidencia: ${jsonFile}\n           ${csvFile}`);
console.log(`Para restaurar: npx tsx tests/integrity-attack.test.mts --restore=${jsonFile} --yes`);

process.exit(effective.length > 0 && detected.length === effective.length && falsePositives.length === 0 ? 0 : 1);

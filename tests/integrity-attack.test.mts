// Prueba de integridad (detección de alteraciones) contra el endpoint real PATCH /api/hack/:id.
//
// Flujo:
//  1. Línea base: lee TODOS los hashes anclados en el contrato (Polygon Amoy) y los registros de
//     GET /api/records; recalcula el hash de cada patientData con cryptoService.generateHash (la misma
//     función y la misma regla que AuditList: VALIDO si el hash recalculado está anclado en la cadena).
//  2. Toma N registros VALIDO y, por cada uno, altera UN campo que forma parte del hash, vía el endpoint.
//  3. Confirma en la API que el valor quedó realmente guardado (alteración efectiva).
//  4. Vuelve a leer cadena + registros y clasifica: alterado detectado si pasa a ALTERADO.
//     También verifica que los registros no tocados sigan VALIDO (falsos positivos).
//  5. Guarda en tests/results/ el JSON completo (incluye los patientData originales) y un CSV.
//
// Requisitos: servidor corriendo (npm run dev), MongoDB local, POLYGON_RPC_URL en .env y NODE_ENV
// distinto de production. attentionTimestamp y aiModelUsed no forman parte del hash y no se alteran aquí.
//
// Uso (desde la raíz del proyecto):
//   npx tsx tests/integrity-attack.test.mts                    -> solo muestra el plan (no modifica nada)
//   npx tsx tests/integrity-attack.test.mts --yes --n=10       -> ejecuta la prueba sobre 10 registros
//   npx tsx tests/integrity-attack.test.mts --yes --ids=a,b,c  -> ejecuta sobre esos _id
//   npx tsx tests/integrity-attack.test.mts --restore=tests/results/integrity-XXXX.json --yes
//                                                              -> restaura los valores originales
// Opcionales: --api=http://localhost:3000/api   ADMIN_WALLET=0x... (por defecto se usa owner() del contrato)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

// Importación dinámica: el proyecto no declara "type": "module" (ver hash-parity.test.mts).
const { ethers } = await import('ethers');
const { generateHash } = await import('../src/services/cryptoService.ts');
const { CONTRACT_ABI, CONTRACT_ADDRESS } = await import('../src/config/contract.ts');

type Status = 'VALIDO' | 'ALTERADO';
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

async function readAnchoredHashes(): Promise<Set<string>> {
  const total = Number(await contract.getTotalRecords());
  if (total === 0) return new Set();
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
  return new Set(recs.map(r => String(r.dataHash).toLowerCase()));
}

// ---------- API ----------
async function getRecords(): Promise<any[]> {
  const res = await fetch(`${API}/records`);
  if (!res.ok) throw new Error(`GET /records respondió ${res.status}`);
  return res.json();
}

async function hack(id: string, body: Record<string, unknown>, adminWallet: string) {
  const res = await fetch(`${API}/hack/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, adminWallet }),
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

// Estado de integridad con la regla de AuditList (líneas 61-71).
async function classify(records: any[], anchored: Set<string>) {
  const out = new Map<string, { hash: string; status: Status }>();
  for (const rec of records) {
    const hash = await generateHash(rec.patientData);
    out.set(rec._id, { hash, status: anchored.has(hash.toLowerCase()) ? 'VALIDO' : 'ALTERADO' });
  }
  return out;
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

async function resolveAdminWallet(): Promise<string> {
  if (process.env.ADMIN_WALLET) return process.env.ADMIN_WALLET;
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
    const res = await hack(r.recordId, r.originalPatientData, adminWallet);
    console.log(`  ${r.recordId}  HTTP ${res.status}`);
  }
  const status = await classify(await getRecords(), await readAnchoredHashes());
  const ok = targets.filter((r: any) => status.get(r.recordId)?.status === 'VALIDO').length;
  console.log(`Restaurados como VALIDO: ${ok}/${targets.length}`);
  process.exit(ok === targets.length ? 0 : 1);
}

// ---------- 1. Línea base ----------
console.log(`API: ${API}\nContrato: ${CONTRACT_ADDRESS}`);
const anchored0 = await readAnchoredHashes();
const records0 = await getRecords();
const status0 = await classify(records0, anchored0);
const valid0 = records0.filter(r => status0.get(r._id)!.status === 'VALIDO');
console.log(`Línea base: ${records0.length} registros en MongoDB, ${anchored0.size} hashes anclados, ${valid0.length} VALIDO, ${records0.length - valid0.length} ALTERADO`);

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

// ---------- 3 y 4. Verificación ----------
const anchored1 = await readAnchoredHashes();
const records1 = await getRecords();
const status1 = await classify(records1, anchored1);
const byId = new Map(records1.map(r => [r._id, r]));

for (const r of results) {
  const stored = byId.get(r.recordId)?.patientData;
  r.storedValue = getPath(stored, r.field);
  r.effective = r.httpStatus === 200 && canon(r.storedValue) === canon(r.after) && canon(r.storedValue) !== canon(r.before);
  r.hashAfter = status1.get(r.recordId)?.hash;
  r.statusAfter = status1.get(r.recordId)?.status;
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
  _id: r.recordId, campo: r.field, antes: JSON.stringify(r.before), despues: JSON.stringify(r.after),
  http: r.httpStatus, efectiva: r.effective, estado: r.statusAfter, detectada: r.detected,
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
  baseline: { records: records0.length, anchoredHashes: anchored0.size, valid: valid0.length },
  summary: {
    attempted: results.length, effective: effective.length, detected: detected.length, detectionRatePct: rate,
    controls: controls.length, falsePositives,
  },
  results,
}, null, 2));
const csvEsc = (v: unknown) => `"${String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/"/g, '""')}"`;
fs.writeFileSync(csvFile, [
  ['recordId', 'campo', 'antes', 'despues', 'http', 'efectiva', 'hashAntes', 'hashDespues', 'estadoDespues', 'detectada'].join(','),
  ...results.map(r => [r.recordId, r.field, r.before, r.after, r.httpStatus, r.effective, r.hashBefore, r.hashAfter, r.statusAfter, r.detected].map(csvEsc).join(',')),
].join('\n'));
console.log(`\nEvidencia: ${jsonFile}\n           ${csvFile}`);
console.log(`Para restaurar: npx tsx tests/integrity-attack.test.mts --restore=${jsonFile} --yes`);

process.exit(effective.length > 0 && detected.length === effective.length && falsePositives.length === 0 ? 0 : 1);

// Prueba de paridad del hash SHA-256 de un registro de triage (RF-09).
// Compara el hash del frontend (cryptoService.generateHash, Web Crypto) con el del backend
// (réplica exacta de generateHashBackend, server.ts, módulo crypto de Node), antes y después de
// pasar los datos por el esquema Record de Mongoose. No se conecta a MongoDB ni inicia el servidor.
//
// Ejecutar desde la raíz del proyecto:  npx tsx tests/hash-parity.test.mts
import nodeCrypto from 'crypto';

// Importación dinámica: el proyecto no declara "type": "module", así que los .ts se cargan como
// CommonJS y las importaciones estáticas con nombre desde este .mts no se resuelven.
const { generateHash } = await import('../src/services/cryptoService.ts');
const { buildHashPayload, serializeForHash } = await import('../src/shared/hashPayload.ts');
const Record = (await import('../server/models/Record.js')).default;

// Réplica de generateHashBackend (server.ts). No se importa server.ts porque arrancaría el servidor.
const generateHashBackend = (data: any): string =>
  nodeCrypto.createHash('sha256').update(serializeForHash(data)).digest('hex');

const patientData: any = {
  id: 'P-001', cedula: '1061000000', name: 'Paciente Prueba', age: '45', gender: 'M', eps: 'Nueva EPS',
  symptoms: 'Dolor torácico opresivo', currentIllness: 'Inicio hace 2 horas',
  vitals: { heartRate: 110, spo2: 93, temperature: 37.2, respiratoryRate: 24,
            bloodPressureSys: 150, bloodPressureDia: 95, bloodPressureMap: 113, painLevel: 8 },
  glasgow: { eyeOpening: 4, verbalResponse: 5, motorResponse: 6, total: 15 },
  checklist: { zLifeSaving: false, aHighRisk: true },
  selectedSymptoms: ['Dolor torácico', 'Modifier: Edad > 65'],
  suggestedEsiLevel: 2, finalEsiLevel: 2, aiLevel: null, aiModelUsed: 'gemini-x',
  triageTimestamp: 1759300000000, estimatedAttentionTime: 15,
  doctorId: '0x1111111111111111111111111111111111111111',
};

let failed = false;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
};

// Contenido hasheado: buildHashPayload (campos y normalización) + serializeForHash (JSON canónico)
const payload = buildHashPayload(patientData);
const serialized = serializeForHash(patientData);
console.log('Payload normalizado :', JSON.stringify(payload));
console.log('Texto serializado   :', serialized);

// 1. Hash del frontend y del backend sobre los mismos datos
const frontHash = await generateHash(patientData);
const backHash = generateHashBackend(patientData);

// 2. Ciclo guardar→leer simulado con el esquema Mongoose (casteo de tipos), sin conexión a BD
const doc = new Record({ patientData, blockchainHash: backHash, blockchainSignature: '0xsig' });
const validationError = doc.validateSync();
check('El documento cumple el esquema Record', !validationError);
if (validationError) console.error(validationError.message);
const fromDb = JSON.parse(JSON.stringify(doc.toObject().patientData));
const frontAfterDbHash = await generateHash(fromDb);

// 3. Control negativo: cambiar finalEsiLevel de 2 a 3
const tamperedHash = await generateHash({ ...fromDb, finalEsiLevel: 3 });

console.log('\nFrontend (WebCrypto):', frontHash);
console.log('Backend  (Node)     :', backHash);
console.log('Frontend tras Mongo :', frontAfterDbHash);
console.log('Alterado (ESI 2→3)  :', tamperedHash, '\n');

check('serializeForHash es idempotente sobre buildHashPayload', serializeForHash(payload) === serialized);
check('Hash frontend = hash backend', frontHash === backHash);
check('Hash backend = hash frontend tras el esquema Mongoose', backHash === frontAfterDbHash);
check('Hash alterado (finalEsiLevel 2→3) es diferente', tamperedHash !== backHash);

if (failed) {
  console.log('\nFAIL');
  process.exit(1);
}
console.log('\nPASS: frontend y backend producen el mismo SHA-256');
process.exit(0);

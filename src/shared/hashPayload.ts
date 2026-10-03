/**
 * Definición ÚNICA del contenido que se hashea (SHA-256) para la integridad de un registro de triage.
 *
 * La usan el cliente (cryptoService.generateHash, Web Crypto, para verificar en AuditList) y el
 * servidor (server.ts, módulo crypto de Node, para el hash que se firma y se ancla en Polygon).
 * Solo produce el texto a hashear: cada lado aplica SHA-256 con su propia API. Así no pueden
 * desalinearse los campos incluidos.
 *
 * Reglas para que el hash sea el mismo antes de guardar (cuerpo de la petición en el servidor) y
 * después de leer de MongoDB (cliente):
 *  - Se toma una lista explícita de campos: lo que Mongoose añada o quite fuera de ella no afecta.
 *  - Los valores se normalizan (números con Number, textos con String, ausentes a un valor fijo),
 *    porque Mongoose convierte tipos y omite campos vacíos al guardar.
 *  - La serialización ordena las claves de forma recursiva (JSON canónico).
 *
 * Campos excluidos a propósito:
 *  - attentionTimestamp: se registra después del triage (PATCH /api/records/:id/attend) y no forma
 *    parte de la decisión clínica anclada.
 *  - aiModelUsed: metadato de la medición (qué modelo de la cascada respondió), no dato clínico.
 *
 * aiLevel sí se incluye: ausente, null o '' se normalizan a null (Mongoose lo guarda como null por
 * defecto), así el hash coincide antes y después de guardar aunque la IA no se haya ejecutado.
 *
 * Si se cambia esta lista, todos los hashes previos dejan de coincidir.
 */

type AnyRecord = Record<string, any>;

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v));
const str = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v));

export function buildHashPayload(data: AnyRecord): AnyRecord {
  const vitals = data.vitals || {};
  const glasgow = data.glasgow || {};
  return {
    id: str(data.id),
    cedula: str(data.cedula),
    name: str(data.name),
    age: num(data.age),
    gender: str(data.gender),
    eps: str(data.eps),
    symptoms: str(data.symptoms),
    currentIllness: str(data.currentIllness),
    vitals: {
      heartRate: num(vitals.heartRate),
      spo2: num(vitals.spo2),
      temperature: num(vitals.temperature),
      respiratoryRate: num(vitals.respiratoryRate),
      bloodPressureSys: num(vitals.bloodPressureSys),
      bloodPressureDia: num(vitals.bloodPressureDia),
      bloodPressureMap: num(vitals.bloodPressureMap),
      painLevel: num(vitals.painLevel),
    },
    glasgow: {
      eyeOpening: num(glasgow.eyeOpening),
      verbalResponse: num(glasgow.verbalResponse),
      motorResponse: num(glasgow.motorResponse),
      total: num(glasgow.total),
    },
    checklist: data.checklist && typeof data.checklist === 'object' ? data.checklist : {},
    // Incluye el shock ("Shock ...") y los factores modificadores ("Modifier: ...")
    selectedSymptoms: Array.isArray(data.selectedSymptoms) ? data.selectedSymptoms.map((s: unknown) => String(s)) : [],
    suggestedEsiLevel: num(data.suggestedEsiLevel),
    finalEsiLevel: num(data.finalEsiLevel),
    aiLevel: num(data.aiLevel),
    overrideReason: str(data.overrideReason) || 'AUTO',
    parentRecordHash: str(data.parentRecordHash) || 'GENESIS',
    correctionReason: str(data.correctionReason) || 'NONE',
    triageTimestamp: num(data.triageTimestamp),
    estimatedAttentionTime: num(data.estimatedAttentionTime),
    doctorId: str(data.doctorId),
  };
}

// JSON con claves ordenadas recursivamente; los arreglos conservan su orden.
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as AnyRecord;
    const entries = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Texto exacto sobre el que se calcula el SHA-256 (cliente y servidor).
export function serializeForHash(data: AnyRecord): string {
  return canonicalStringify(buildHashPayload(data));
}

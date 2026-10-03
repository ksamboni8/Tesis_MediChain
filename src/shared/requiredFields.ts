/**
 * Definición ÚNICA de los campos obligatorios de un triage.
 *
 * La usan el cliente (TriageForm: deshabilitar "Guardar" / "Analizar con IA" y listar lo que falta)
 * y el servidor (server.ts: rechazar /api/records/invisible y /api/triage/analyze antes de hashear,
 * anclar o consultar a la IA). Así la regla no puede desalinearse entre los dos lados.
 *
 * Criterio de "falta":
 *  - Relato (motivo de consulta, enfermedad actual): ausente o solo espacios.
 *  - Signo vital: cualquier cosa que no sea un número finito ('' del formulario vacío o de un sensor
 *    que no entregó dato, null, undefined, NaN). El 0 cuenta como valor registrado (lo usa el botón
 *    "signos vitales en 0").
 *  - Subescala de Glasgow: cualquier cosa que no sea un entero dentro de su rango (ocular 1-4,
 *    verbal 1-5, motora 1-6). El formulario las inicia en null ("sin evaluar"), así que solo pasan
 *    si el médico eligió un valor en cada una; un 4/5/6 elegido explícitamente es válido.
 *
 * Dolor (EVA), shock y modificadores no son obligatorios a propósito.
 */

type AnyRecord = Record<string, any>;

export const REQUIRED_VITALS = [
  { key: 'heartRate', label: 'Frecuencia cardíaca' },
  { key: 'spo2', label: 'SpO₂' },
  { key: 'temperature', label: 'Temperatura' },
  { key: 'respiratoryRate', label: 'Frecuencia respiratoria' },
  { key: 'bloodPressureSys', label: 'Presión arterial sistólica' },
  { key: 'bloodPressureDia', label: 'Presión arterial diastólica' },
] as const;

export const REQUIRED_GLASGOW = [
  { key: 'eyeOpening', label: 'Glasgow: apertura ocular', max: 4 },
  { key: 'verbalResponse', label: 'Glasgow: respuesta verbal', max: 5 },
  { key: 'motorResponse', label: 'Glasgow: respuesta motora', max: 6 },
] as const;

const isFilledText = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
const isRecordedVital = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const isGlasgowScore = (v: unknown, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

// Etiquetas de los campos de relato que faltan (lo que exige "Analizar con IA")
export function missingNarrativeFields(data: AnyRecord): string[] {
  const missing: string[] = [];
  if (!isFilledText(data?.symptoms)) missing.push('Motivo de consulta');
  if (!isFilledText(data?.currentIllness)) missing.push('Enfermedad actual');
  return missing;
}

// Etiquetas de todos los campos obligatorios que faltan para guardar el triage
export function missingRequiredTriageFields(data: AnyRecord): string[] {
  const vitals = data?.vitals || {};
  const glasgow = data?.glasgow || {};
  return [
    ...missingNarrativeFields(data),
    ...REQUIRED_VITALS.filter(({ key }) => !isRecordedVital(vitals[key])).map(({ label }) => label),
    ...REQUIRED_GLASGOW.filter(({ key, max }) => !isGlasgowScore(glasgow[key], max)).map(({ label }) => label),
  ];
}

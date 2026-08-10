// Contrato de honestidad de los datos que devuelve una tool AI.
//
// El Director Comercial le cita números a un manager. Un número silenciosamente
// incompleto es la peor falla posible del sistema — peor que no responder.
// PostgREST corta TODO select en 1.000 filas sin avisar, así que "conté las
// filas que me trajo la query" no es una respuesta: es una apuesta.
//
// Por eso cada tool devuelve { data, meta } y `meta` declara explícitamente
// cuántas filas se consideraron, de dónde salieron y qué NO dice el número.
// Si hay una sola limitación, complete = false y el agente tiene que decirlo.
//
// Ver supabase/migrations/0023_ai_aggregates.sql: los agregados se calculan en
// Postgres y devuelven rows_considered + advertencias, que se mapean acá.

import { todayMX } from "@/lib/dates";

export interface DataCompleteness {
  /** true SOLO si no hay ninguna limitación declarada. */
  complete: boolean;
  /** Filas que el servidor MIRÓ para calcular (no las que devolvió). */
  rows_considered: number;
  /** De dónde salió el número: rpc/tabla/función, para poder auditarlo. */
  data_source: string;
  /** Instante del cálculo, en hora de negocio (America/Mexico_City). */
  calculated_at: string;
  /** Qué NO dice el número. Vacío ⇒ complete. */
  limitations: string[];
}

/**
 * Timestamp ISO-8601 con el offset de México.
 *
 * La parte de fecha sale de `todayMX()` (lib/dates.ts) para que el día de
 * negocio sea el correcto: el server corre en UTC y un cálculo de las 19:00 de
 * México figuraría al día siguiente.
 */
export function mxTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // "GMT-06:00" → "-06:00"; si el runtime no lo soporta, se declara UTC honesto.
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const offset = /GMT([+-]\d{2}:\d{2})/.exec(tzName)?.[1] ?? null;
  if (offset == null) return now.toISOString();
  return `${todayMX()}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

/** Resultado completo: nada quedó afuera. Con limitaciones deja de serlo. */
export function complete(
  rows: number,
  source: string,
  limitations: string[] = []
): DataCompleteness {
  const lims = clean(limitations);
  return {
    complete: lims.length === 0,
    rows_considered: rows,
    data_source: source,
    calculated_at: mxTimestamp(),
    limitations: lims,
  };
}

/** Resultado que NO cubre todo: siempre complete=false y siempre con motivo. */
export function incomplete(
  rows: number,
  source: string,
  limitations: string[]
): DataCompleteness {
  const lims = clean(limitations);
  return {
    complete: false,
    rows_considered: rows,
    data_source: source,
    calculated_at: mxTimestamp(),
    // incompleto sin motivo es peor que incompleto: obliga a declarar algo.
    limitations: lims.length
      ? lims
      : ["el resultado se declaró incompleto sin detallar por qué"],
  };
}

/** Envoltorio estándar de toda tool de lectura: el dato y su honestidad. */
export function withMeta<T>(data: T, meta: DataCompleteness): { data: T; meta: DataCompleteness } {
  return { data, meta };
}

/**
 * Meta a partir de la respuesta de un RPC de 0023, que ya trae
 * `rows_considered` y `advertencias` calculados en Postgres.
 * Devuelve también el payload sin esas claves (van en meta, no en data).
 */
export function fromRpc<T extends Record<string, unknown>>(
  payload: T,
  source: string,
  extraLimitations: string[] = []
): { data: Omit<T, "rows_considered" | "advertencias">; meta: DataCompleteness } {
  const { rows_considered, advertencias, ...rest } = payload;
  const rows = typeof rows_considered === "number" ? rows_considered : 0;
  const fromSql = Array.isArray(advertencias) ? advertencias.map(String) : [];
  const lims = clean([...fromSql, ...extraLimitations]);
  return {
    data: rest as Omit<T, "rows_considered" | "advertencias">,
    meta: lims.length ? incomplete(rows, source, lims) : complete(rows, source),
  };
}

/** Limitación estándar de lista capada: dice el tope Y el total verdadero. */
export function cappedListLimitation(
  shown: number,
  total: number,
  what: string,
  order?: string
): string[] {
  if (shown >= total) return [];
  return [
    `lista capada: se muestran ${shown} de ${total} ${what}${order ? ` (orden: ${order})` : ""}.`,
  ];
}

function clean(limitations: string[]): string[] {
  const out: string[] = [];
  for (const l of limitations) {
    const t = typeof l === "string" ? l.trim() : "";
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

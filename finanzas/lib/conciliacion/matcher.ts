// Motor de conciliación: port TypeScript de consultorio-gestion/conciliar_mp.py
// (validado contra los datos reales de MP May–Jul 2026).
//
// Pasadas, en orden y con la misma semántica:
//   0. external_key exacto (nueva: dedup perfecto cuando el origen trae id)
//   1. nombre compatible (score > 0.5) + monto ±1 + fecha ±4d — greedy por (score, −Δfecha)
//   2. agrupados: una línea = suma de 2-3 movimientos del mismo nombre (score ≥ 0.5), ±35d
//      (corre ANTES que monto-único para no robarle filas)
//   2b. líneas agrupadas (el caso inverso, real y frecuente): el paciente paga en
//      DOS transferencias el mismo día y la caja lo anota como un solo cobro
//      (Badiola: 400.000 + 234.000 en el banco = 634.000 en la caja).
//   3. monto + fecha con candidato ÚNICO (pagador ≠ paciente)
//   4. sobrantes mutuos: un solo candidato con score ≥ 0.5 + monto + fecha
//
// El "SequenceMatcher.ratio() ≥ 0.8" del original se reemplaza por Dice de
// bigramas ≥ 0.8 (misma tolerancia a typos en tokens ≥ 5 chars; cubierto por
// tests con los casos reales: Lindsell↔Fernandez Lindsell, typos de nombres).

import { norm } from "@/lib/import/normalize";
import { daysBetween } from "@/lib/import/normalize";

const STOPWORDS = new Set([
  "dni", "cuit", "dra", "dr", "de", "del", "la", "los", "maria", "jose", "juan",
]);

export function tokens(nombre: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of norm(nombre).split(/\s+/)) {
    if (!t || t.length <= 2 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** Similitud Dice de bigramas — equivalente práctico del ratio() de difflib. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let inter = 0;
  for (const [g, n] of ba) inter += Math.min(n, bb.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

export function tokEq(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 5) return similarity(a, b) >= 0.8;
  return false;
}

/** inter / min(|ta|,|tb|) — igual que el original. */
export function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  const ta = [...tokens(a)];
  const tb = [...tokens(b)];
  if (!ta.length || !tb.length) return 0;
  let inter = 0;
  for (const x of ta) if (tb.some((y) => tokEq(x, y))) inter++;
  return inter / Math.min(ta.length, tb.length);
}

// ---------------------------------------------------------------------------

export type LineaExtracto = {
  id: string;
  fecha: string;        // YYYY-MM-DD
  monto: number;        // positivo (crédito) — el caller filtra el signo que quiere matchear
  nombre: string;       // contraparte cruda del extracto
  externalKey?: string | null;
};

export type MovimientoCandidato = {
  id: string;
  fecha: string;
  monto: number;        // amount (positivo)
  nombre: string;       // paciente / contraparte
  externalKey?: string | null;
};

export type Sugerencia = {
  lineaId: string;
  movementIds: string[];   // 1 normal · 2-3 agrupado
  score: number;
  method:
    | "external_key" | "nombre_monto_fecha" | "agrupado"
    | "lineas_agrupadas"   // varias líneas del banco cierran contra UN cobro
    | "monto_unico" | "sobrante_mutuo";
};

export type ResultadoMatch = {
  sugerencias: Sugerencia[];
  lineasSinMatch: string[];      // → no_identificado
};

export function matchear(
  lineas: LineaExtracto[],
  movimientos: MovimientoCandidato[],
  opts: { toleranciaMonto?: number } = {}
): ResultadoMatch {
  const tol = opts.toleranciaMonto ?? 1;
  const sugerencias: Sugerencia[] = [];
  const usadasLineas = new Set<string>();
  const usadosMovs = new Set<string>();

  // pasada 0: external_key exacto
  const porKey = new Map<string, MovimientoCandidato>();
  for (const m of movimientos) if (m.externalKey) porKey.set(m.externalKey, m);
  for (const l of lineas) {
    if (!l.externalKey) continue;
    const m = porKey.get(l.externalKey);
    if (m && !usadosMovs.has(m.id)) {
      usadasLineas.add(l.id);
      usadosMovs.add(m.id);
      sugerencias.push({ lineaId: l.id, movementIds: [m.id], score: 1, method: "external_key" });
    }
  }

  // pasada 1: nombre + monto + fecha, greedy por (score, −Δfecha)
  const pares: Array<{ sc: number; negd: number; l: LineaExtracto; m: MovimientoCandidato }> = [];
  for (const l of lineas) {
    if (usadasLineas.has(l.id)) continue;
    for (const m of movimientos) {
      if (usadosMovs.has(m.id)) continue;
      if (Math.abs(m.monto - l.monto) < tol && daysBetween(m.fecha, l.fecha) <= 4) {
        const sc = nameScore(m.nombre, l.nombre);
        if (sc > 0.5) pares.push({ sc, negd: -daysBetween(m.fecha, l.fecha), l, m });
      }
    }
  }
  pares.sort((a, b) => b.sc - a.sc || b.negd - a.negd);
  for (const { sc, l, m } of pares) {
    if (usadasLineas.has(l.id) || usadosMovs.has(m.id)) continue;
    usadasLineas.add(l.id);
    usadosMovs.add(m.id);
    sugerencias.push({ lineaId: l.id, movementIds: [m.id], score: sc, method: "nombre_monto_fecha" });
  }

  // pasada 2: agrupados 2-3 filas, ±35 días — antes que monto único
  for (const l of lineas) {
    if (usadasLineas.has(l.id)) continue;
    const pool = movimientos.filter(
      (m) =>
        !usadosMovs.has(m.id) &&
        m.monto > 0 &&
        daysBetween(m.fecha, l.fecha) <= 35 &&
        nameScore(m.nombre, l.nombre) >= 0.5
    );
    const combo = buscarCombo(pool, l.monto, tol);
    if (combo) {
      usadasLineas.add(l.id);
      for (const m of combo) usadosMovs.add(m.id);
      sugerencias.push({
        lineaId: l.id,
        movementIds: combo.map((m) => m.id),
        score: 0.6,
        method: "agrupado",
      });
    }
  }

  // pasada 2b: varias LÍNEAS contra un movimiento (pago partido en el banco)
  for (const m of movimientos) {
    if (usadosMovs.has(m.id)) continue;
    const pool = lineas.filter(
      (l) =>
        !usadasLineas.has(l.id) &&
        l.monto > 0 &&
        daysBetween(l.fecha, m.fecha) <= 5 &&
        nameScore(l.nombre, m.nombre) >= 0.5
    );
    const combo = buscarComboLineas(pool, m.monto, tol);
    if (combo) {
      usadosMovs.add(m.id);
      for (const l of combo) {
        usadasLineas.add(l.id);
        sugerencias.push({
          lineaId: l.id,
          movementIds: [m.id],
          score: 0.6,
          method: "lineas_agrupadas",
        });
      }
    }
  }

  // pasada 3: monto + fecha con candidato único
  for (const l of lineas) {
    if (usadasLineas.has(l.id)) continue;
    const cands = movimientos.filter(
      (m) =>
        !usadosMovs.has(m.id) &&
        Math.abs(m.monto - l.monto) < tol &&
        daysBetween(m.fecha, l.fecha) <= 4
    );
    if (cands.length === 1) {
      usadasLineas.add(l.id);
      usadosMovs.add(cands[0].id);
      sugerencias.push({ lineaId: l.id, movementIds: [cands[0].id], score: 0, method: "monto_unico" });
    }
  }

  // pasada 4: sobrantes mutuos con score ≥ 0.5
  for (const l of lineas) {
    if (usadasLineas.has(l.id)) continue;
    const cands = movimientos
      .filter(
        (m) =>
          !usadosMovs.has(m.id) &&
          Math.abs(m.monto - l.monto) < tol &&
          daysBetween(m.fecha, l.fecha) <= 4
      )
      .map((m) => ({ sc: nameScore(m.nombre, l.nombre), m }))
      .filter((x) => x.sc >= 0.5);
    if (cands.length === 1) {
      usadasLineas.add(l.id);
      usadosMovs.add(cands[0].m.id);
      sugerencias.push({
        lineaId: l.id,
        movementIds: [cands[0].m.id],
        score: cands[0].sc,
        method: "sobrante_mutuo",
      });
    }
  }

  return {
    sugerencias,
    lineasSinMatch: lineas.filter((l) => !usadasLineas.has(l.id)).map((l) => l.id),
  };
}

/** Igual que buscarCombo pero del lado de las líneas de extracto. */
function buscarComboLineas(
  pool: LineaExtracto[],
  objetivo: number,
  tol: number
): LineaExtracto[] | null {
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      if (Math.abs(pool[i].monto + pool[j].monto - objetivo) < tol) return [pool[i], pool[j]];
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      for (let k = j + 1; k < pool.length; k++)
        if (Math.abs(pool[i].monto + pool[j].monto + pool[k].monto - objetivo) < tol)
          return [pool[i], pool[j], pool[k]];
  return null;
}

/** Combinaciones de 2 y después 3 que sumen el monto (igual que el original). */
function buscarCombo(
  pool: MovimientoCandidato[],
  objetivo: number,
  tol: number
): MovimientoCandidato[] | null {
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      if (Math.abs(pool[i].monto + pool[j].monto - objetivo) < tol) return [pool[i], pool[j]];
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      for (let k = j + 1; k < pool.length; k++)
        if (Math.abs(pool[i].monto + pool[j].monto + pool[k].monto - objetivo) < tol)
          return [pool[i], pool[j], pool[k]];
  return null;
}

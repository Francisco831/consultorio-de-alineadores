/**
 * Impacto del equipo comercial sobre el comportamiento de los doctores.
 *
 * LA HONESTIDAD DE ESTE MÓDULO ES SU RAZÓN DE SER. México produce 13-35 casos
 * nuevos por mes de ~100 doctores vivos: no hay N para probar que un llamado
 * causa casos. Cuatro diseños independientes lo intentaron y el que menos mintió
 * fue el que dejó de intentarlo.
 *
 * Por eso acá NO hay score por persona ni ranking. Hay tres cosas:
 *   1. EL RELOJ: el estado de la cartera medido contra el ritmo propio de cada
 *      doctor. No depende de atribución, nadie lo puede inflar cargando notas.
 *   2. LA VENTANA ESPEJO CON PLACEBO: el antes/después de cada persona, SIEMPRE
 *      al lado del mismo antes/después un año antes, cuando no había tocado a
 *      nadie. Sin la columna placebo el número es ruido leído como logro: el
 *      placebo de Juan sube tanto como su ventana real.
 *   3. LO QUE NADIE EXPLICA: los doctores que producen sin contacto registrado.
 */

import { TIPOS_CONTACTO } from "@/lib/atribucion";

const DIA = 86_400_000;

export type EstadoCadencia = "al_dia" | "atrasado" | "dormido" | "perdido";

export const ESTADO_LABEL: Record<EstadoCadencia, string> = {
  al_dia: "Al día",
  atrasado: "Atrasado",
  dormido: "Dormido",
  perdido: "Perdido",
};

/** doctor_id → fechas (ms) de sus casos nuevos, ordenadas */
export type CasosPorDoctor = Map<string, number[]>;

export function casosPorDoctor(
  casos: { doctor_id: string; fecha_ingreso: string }[]
): CasosPorDoctor {
  const m: CasosPorDoctor = new Map();
  for (const c of casos) {
    let l = m.get(c.doctor_id);
    if (!l) m.set(c.doctor_id, (l = []));
    l.push(Date.parse(c.fecha_ingreso));
  }
  for (const l of m.values()) l.sort((a, b) => a - b);
  return m;
}

/**
 * El reloj de UN doctor a una fecha de corte.
 *
 * `base` = mediana de los intervalos ya cerrados entre sus casos nuevos, acotada
 * a [14, 365] días. Hacen falta AL MENOS 2 intervalos cerrados (3 casos): con
 * menos, el doctor no tiene ritmo propio y queda FUERA de la medición. Rellenar
 * con un default (45 días) mete cientos de doctor-mes que por construcción nunca
 * pueden volver a "al día", y eso es lo que fabricaba diferencias que no existen.
 */
export function relojDeDoctor(
  fechas: number[],
  corte: number
): { base: number; dias: number; estado: EstadoCadencia } | null {
  const hasta = fechas.filter((t) => t <= corte);
  if (hasta.length < 3) return null;
  const gaps = hasta
    .slice(1)
    .map((t, i) => (t - hasta[i]) / DIA)
    .sort((a, b) => a - b);
  const med =
    gaps.length % 2
      ? gaps[(gaps.length - 1) / 2]
      : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  const base = Math.min(365, Math.max(14, med));
  const dias = (corte - hasta[hasta.length - 1]) / DIA;
  const estado: EstadoCadencia =
    dias > 365 ? "perdido" : dias / base > 3 ? "dormido" : dias / base > 1.2 ? "atrasado" : "al_dia";
  return { base, dias, estado };
}

export type PuntoCadencia = {
  mes: string;
  elegibles: number;
  al_dia: number;
  atrasado: number;
  dormido: number;
  perdido: number;
};

/**
 * Serie mensual del estado de la cartera. Solo meses COMPLETOS: el mes en curso
 * se mide contra un fin de mes que todavía no pasó y sale siempre peor.
 */
export function serieCadencia(
  cd: CasosPorDoctor,
  desdeMes: string,
  ultimoMesCompleto: string
): PuntoCadencia[] {
  const out: PuntoCadencia[] = [];
  let [y, m] = desdeMes.split("-").map(Number);
  for (;;) {
    const mes = `${y}-${String(m).padStart(2, "0")}`;
    if (mes > ultimoMesCompleto) break;
    const finDeMes = Date.UTC(y, m, 0, 23, 59, 59);
    const p: PuntoCadencia = { mes, elegibles: 0, al_dia: 0, atrasado: 0, dormido: 0, perdido: 0 };
    for (const fechas of cd.values()) {
      const r = relojDeDoctor(fechas, finDeMes);
      if (!r) continue;
      p.elegibles++;
      p[r.estado]++;
    }
    out.push(p);
    m++;
    if (m === 13) { m = 1; y++; }
  }
  return out;
}

export type Tier = "A" | "B" | "C";

export type FilaTier = {
  tier: Tier;
  doctores: number;
  casos12m: number;
  /** vencidos de su propio reloj y sin caso nuevo en 30 días */
  deuda: number;
  /** contactados en los últimos 30 días — al lado del criterio, NUNCA adentro */
  tocados30d: number;
};

export function tierDe(casos12m: number): Tier {
  return casos12m >= 4 ? "A" : casos12m >= 1 ? "B" : "C";
}

export function resumenTiers(
  cd: CasosPorDoctor,
  ultimoToque: Map<string, number>,
  ahora: number
): FilaTier[] {
  const filas: Record<Tier, FilaTier> = {
    A: { tier: "A", doctores: 0, casos12m: 0, deuda: 0, tocados30d: 0 },
    B: { tier: "B", doctores: 0, casos12m: 0, deuda: 0, tocados30d: 0 },
    C: { tier: "C", doctores: 0, casos12m: 0, deuda: 0, tocados30d: 0 },
  };
  for (const [dr, fechas] of cd) {
    const n12 = fechas.filter((t) => t >= ahora - 365 * DIA).length;
    const f = filas[tierDe(n12)];
    f.doctores++;
    f.casos12m += n12;
    const reloj = relojDeDoctor(fechas, ahora);
    const sinCasoReciente = !fechas.some((t) => t >= ahora - 30 * DIA);
    // la deuda NO mira si alguien lo tocó: si el criterio incluyera el contacto,
    // diez WhatsApp borrarían la deuda sin que el doctor mande un solo caso
    if (reloj && reloj.estado !== "al_dia" && sinCasoReciente) f.deuda++;
    const ult = ultimoToque.get(dr);
    if (ult !== undefined && ult >= ahora - 30 * DIA) f.tocados30d++;
  }
  return [filas.A, filas.B, filas.C];
}

/** Primer contacto de cada persona con cada doctor: doctor_id → ms */
export function primerToquePorPersona(
  toques: { doctor_id: string; created_by: string | null; occurred_at: string; type: string }[]
): Map<string, Map<string, number>> {
  const tipos = new Set<string>(TIPOS_CONTACTO);
  const out = new Map<string, Map<string, number>>();
  for (const t of toques) {
    if (!t.created_by || !tipos.has(t.type)) continue;
    let m = out.get(t.created_by);
    if (!m) out.set(t.created_by, (m = new Map()));
    const ts = Date.parse(t.occurred_at);
    const prev = m.get(t.doctor_id);
    if (prev === undefined || ts < prev) m.set(t.doctor_id, ts);
  }
  return out;
}

export type VentanaEspejo = {
  personaId: string;
  doctores: number;
  antes: number;
  despues: number;
  suben: number;
  antesPlacebo: number;
  despuesPlacebo: number;
  subenPlacebo: number;
};

/**
 * Antes/después alrededor del primer contacto, con el MISMO cálculo corrido un
 * año antes (placebo). La ventana es simétrica y se acota a 180 días; los
 * doctores con menos de `minDias` de ventana quedan afuera porque no tienen
 * "después" todavía.
 */
export function ventanaEspejo(
  primerToque: Map<string, number>,
  personaId: string,
  cd: CasosPorDoctor,
  ahora: number,
  maxDias = 180,
  minDias = 90
): VentanaEspejo {
  const r: VentanaEspejo = {
    personaId, doctores: 0, antes: 0, despues: 0, suben: 0,
    antesPlacebo: 0, despuesPlacebo: 0, subenPlacebo: 0,
  };
  for (const [dr, t0] of primerToque) {
    const w = Math.min(maxDias, (ahora - t0) / DIA);
    if (w < minDias) continue;
    const fechas = cd.get(dr) ?? [];
    const entre = (a: number, b: number) => fechas.filter((t) => t >= a && t < b).length;
    const ancho = w * DIA;
    const a = entre(t0 - ancho, t0);
    const d = entre(t0, t0 + ancho);
    const t0p = t0 - 365 * DIA;
    const ap = entre(t0p - ancho, t0p);
    const dp = entre(t0p, t0p + ancho);
    r.doctores++;
    r.antes += a; r.despues += d; if (d > a) r.suben++;
    r.antesPlacebo += ap; r.despuesPlacebo += dp; if (dp > ap) r.subenPlacebo++;
  }
  return r;
}

/** Último día del mes completo anterior a `hoy` (YYYY-MM). */
export function ultimoMesCompleto(hoyISO: string): string {
  const [y, m] = hoyISO.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

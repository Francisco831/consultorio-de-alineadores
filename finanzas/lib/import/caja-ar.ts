// Parser de la caja del consultorio: JSON crudo del Apps Script → movimientos.
//
// Port EXACTO de `scripts/parse_caja.py --raw-a-movs`. Existe porque el sync
// pasó a correr en Vercel (cron), donde no hay python3. El modo --xlsx-a-raw
// sigue viviendo en python: openpyxl solo hace falta para el camino manual.
//
// La clasificación y el orden de recorrido son IDÉNTICOS al parser original:
// las external_key del import dependen de eso (contenido + ordinal intra-día).
// lib/import/caja-ar.test.ts vuelve a parsear el raw de seed-data y exige que
// salga igualito al .json que hoy produce python. Si tocás algo acá, ese test
// es el que avisa que las claves se movieron.

/** Pestaña de la caja → doctora. El orden importa: fija el orden de salida. */
export const TABS: Record<string, string> = {
  "MONI": "Mónica González",
  "MARIANA  MATELLI": "Mariana Matelli",
  "MARIANA KS": "Mariana Franco",
  "ROCIO 2025": "Rocío Puig",
  "EUGENIA 2020": "Eugenia Digiano",
  "CONI 2020": "Coni",
  "VIRGINIA ": "Virginia",
};

export const TAB_SOLICITUD = "SOLICITUD FACTURAS Y CONSULTAS ";

export type MovCaja = {
  fecha: string;
  mes: number;
  doctora: string | null;
  atribucion_clara: boolean;
  tab: string;
  paciente: string | null;
  ars: number;
  usd: number;
  medio: string | null;
  motivo: string | null;
  obs: string | null;
  tipo: "cobro" | "retiro_liquidacion" | "gasto_consultorio" | "gasto_tratamiento";
  categoria: string | null;
};

export type RawCaja = { tabs?: Record<string, unknown[][]> };

/** Celda ya materializada: la fecha deja de ser texto y pasa a ser fecha. */
type Celda = string | number | Date | null;

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "setiembre", "octubre", "noviembre", "diciembre",
];

const RE_CUOTA = /c(?:uo)?ta\s*\.?\s*(\d+)\s*de\s*(\d+)/i;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_TC = /t\/?c\s*\$?\s*[\d.,]+/i;
const RE_MENSUALIDAD = /\bmensualidad/;

export function classify(
  paciente: string, motivo: string, obs: string,
  montoArs: number | null, montoUsd: number | null, medio = ""
): [MovCaja["tipo"], string | null] {
  // el medio entra al texto: la caja a veces corre las columnas y el
  // "Abona cuota X de Y" cae ahí; y "tc 1550" = cuota pagada en dólares
  const p = norm(paciente || ""), m = norm(motivo || ""), o = norm(obs || "");
  const texto = [p, m, o, norm(medio || "")].join(" ");
  const neg = (montoArs !== null && montoArs < 0) || (montoUsd !== null && montoUsd < 0);
  if (neg) {
    if (texto.includes("liquidacion") || texto.includes("retiro") || texto.includes("rendicion")) {
      return ["retiro_liquidacion", null];
    }
    if (["lab", "insumo", "botones", "yeso", "silicona"].some((k) => texto.includes(k))) {
      return ["gasto_tratamiento", null];
    }
    return ["gasto_consultorio", null];
  }
  if (RE_CUOTA.test(`${motivo || ""} ${obs || ""}`) || texto.includes("cuota") || texto.includes("etapa adicional")) {
    return ["cobro", "Alineadores"];
  }
  // "abona (el) tratamiento", "resto del tratamiento": venta de tratamiento
  // sin la palabra cuota (pago total o saldo final)
  if (texto.includes("tratamiento")) return ["cobro", "Alineadores"];
  if (RE_TC.test(texto)) return ["cobro", "Alineadores"];
  if (texto.includes("contenc")) return ["cobro", "Contención"];
  if (texto.includes("consult") || texto.includes("1era") || texto.includes("1ra") || texto.includes("primera")) {
    return ["cobro", "Consulta"];
  }
  if (MESES.some((mes) => texto.includes(mes)) || RE_MENSUALIDAD.test(texto)) {
    return ["cobro", "Mensualidad"];
  }
  return ["cobro", "Otros"];
}

const NOMBRES_DRAS: Array<[string, string]> = [
  ["matelli", "Mariana Matelli"], ["franco", "Mariana Franco"],
  ["moni", "Mónica González"], ["monica", "Mónica González"],
  ["rocio", "Rocío Puig"], ["eugenia", "Eugenia Digiano"],
  ["coni", "Coni"], ["virginia", "Virginia"],
];

function atribuirRetiro(texto: string, draTab: string): [string, boolean] {
  const t = norm(texto);
  for (const [clave, nombre] of NOMBRES_DRAS) if (t.includes(clave)) return [nombre, true];
  return [draTab, false];
}

/**
 * Normaliza una celda del JSON a lo que devolvería openpyxl.
 *
 * Las fechas llegan del GAS como "yyyy-MM-dd". Los enteros: python distingue
 * int de float y `str()` los escribe distinto ("1" vs "1.0") — en JS `String()`
 * ya imprime 1.0 como "1", así que el int/float del port no hace falta.
 */
function celda(c: unknown): Celda {
  if (typeof c === "string" && RE_FECHA.test(c)) {
    const [y, m, d] = c.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  if (typeof c === "number" || typeof c === "string") return c;
  return c == null ? null : (c as Celda);
}

/**
 * Lo que python hace con `str(x or '')`: 0, '' y null caen en cadena vacía.
 *
 * Una fecha en la columna de paciente/motivo/obs existe de verdad (la caja las
 * tiene) y llega a la external_key: hay que escribirla como `str(datetime)` de
 * python — "2026-11-10 00:00:00" — o la clave cambia y el movimiento se duplica.
 */
function texto(c: Celda): string {
  if (c === null || c === undefined || c === "" || c === 0) return "";
  if (c instanceof Date) return `${c.toISOString().slice(0, 10)} 00:00:00`;
  return String(c);
}

export function parseTab(rows: unknown[][], tab: string, dra: string, year = 2026): MovCaja[] {
  const movs: MovCaja[] = [];
  for (const fila of rows) {
    const r: Celda[] = [...fila.map(celda), ...Array(14).fill(null)];
    let fecha: Date | null = null, fi = -1;
    for (let i = 0; i < r.length; i++) {
      const c = r[i];
      if (c instanceof Date) { fecha = c; fi = i; break; }
    }
    if (!fecha || fecha.getUTCFullYear() !== year) continue;

    const paciente = r[fi + 2], medio = r[fi + 6], motivo = r[fi + 7], obs = r[fi + 8];
    const ars = r[fi + 4] as Celda, usd = r[fi + 5] as Celda;
    if (paciente === null && ars === null && usd === null) continue;
    const num = (x: Celda) => (typeof x === "number" ? x : null);
    const nArs = num(ars), nUsd = num(usd);
    if (nArs === null && nUsd === null) continue;
    if (nArs === 0 && (nUsd === null || nUsd === 0)) continue;

    const [tipo, cat] = classify(
      texto(paciente), texto(motivo), texto(obs), nArs, nUsd, texto(medio)
    );
    let draAttr = dra, attrClara = true;
    if (tipo === "retiro_liquidacion") {
      [draAttr, attrClara] = atribuirRetiro(
        [paciente, motivo, obs].map(texto).join(" "), dra
      );
    }
    movs.push({
      fecha: fecha.toISOString().slice(0, 10), mes: fecha.getUTCMonth() + 1,
      doctora: draAttr, atribucion_clara: attrClara, tab: tab.trim(),
      paciente: texto(paciente).trim(),
      ars: nArs || 0, usd: nUsd || 0,
      medio: texto(medio).trim(), motivo: texto(motivo).trim(),
      obs: texto(obs).trim(), tipo, categoria: cat,
    });
  }
  return movs;
}

/** El raw completo del Apps Script → los movimientos 2026 de todas las pestañas. */
export function rawAMovs(raw: RawCaja, avisar: (m: string) => void = () => {}): MovCaja[] {
  const movs: MovCaja[] = [];
  for (const [tab, dra] of Object.entries(TABS)) {
    const rows = raw.tabs?.[tab];
    if (!rows) { avisar(`falta la pestaña '${tab}' en el raw`); continue; }
    movs.push(...parseTab(rows, tab, dra));
  }
  return movs;
}

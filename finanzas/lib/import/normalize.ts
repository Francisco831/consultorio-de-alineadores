// Normalización compartida por importadores y matcher.
// Port fiel de norm() de consultorio-gestion/parse_caja.py.

/** lower + sin acentos (NFD, quita marcas diacríticas) + trim. */
export function norm(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim();
}

/** "1.711.272,40" → 1711272.4 · "1,711,272.40" → 1711272.4 · Excel numérico pasa directo. */
export function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let str = String(raw).trim();
  // tokens de moneda permitidos; cualquier OTRA letra invalida la celda:
  // "SF BADIOLA/R 20410718554 VAR VARIOS" es un CUIT con texto, no un monto —
  // strippear letras y concatenar dígitos fabricaba montos de miles de millones.
  str = str.replace(/\b(ars|usd|mxn)\b|u\$s|us\$|\$/gi, "");
  if (/[a-z]/i.test(str)) return null;
  const s = str.replace(/[^\d.,-]/g, "");
  if (!s || s === "-") return null;
  const n = normalizeSeparators(s);
  return n != null && Number.isFinite(n) ? n : null;
}

// misma regla que lib/money.ts (grupos de 3 dígitos = miles); duplicada acá a
// propósito: este módulo lo usan scripts de terminal sin el alias "@/"
function normalizeSeparators(s: string): number | null {
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (lastDot >= 0) {
    normalized = /^-?\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, "") : s;
  } else if (lastComma >= 0) {
    normalized = /^-?\d{1,3}(,\d{3})+$/.test(s)
      ? s.replace(/,/g, "")
      : s.replace(",", ".");
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Fechas de los orígenes reales: SIEMPRE DD/MM (jamás autodetectar MM/DD),
 *  ISO YYYY-MM-DD, o serial de Excel. Devuelve YYYY-MM-DD o null. */
export function parseDateDDMM(raw: string | number | Date | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    // los xlsx traen Date en UTC; usar los componentes UTC evita el corrimiento
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, "0");
    const d = String(raw.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof raw === "number") {
    // serial Excel (época 1899-12-30)
    if (raw < 20000 || raw > 60000) return null;
    const ms = Math.round((raw - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (dm) {
    const d = Number(dm[1]);
    const m = Number(dm[2]);
    let y = Number(dm[3]);
    if (y < 100) y += 2000;
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

/** Días absolutos entre dos fechas ISO. */
export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(a) - Date.parse(b));
  return Math.round(ms / 86400000);
}

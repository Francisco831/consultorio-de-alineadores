// Único módulo de dinero de la app.
// Regla de oro: las monedas NUNCA se convierten ni se suman entre sí;
// todo total es un bucket por moneda. Por eso acá no existe (ni va a
// existir) ninguna función de conversión.

const SYMBOL_OVERRIDES: Record<string, string> = {
  // es-AR muestra USD como "US$"; el resto usa el símbolo del locale.
  USD: "US$",
};

export function formatMoney(
  amount: number | string | null | undefined,
  currency: string,
  locale: string,
  opts: { decimals?: boolean; sign?: boolean } = {}
): string {
  if (amount == null || amount === "") return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: opts.decimals ? 2 : 0,
    minimumFractionDigits: opts.decimals ? 2 : 0,
    signDisplay: opts.sign ? "exceptZero" : "auto",
  });
  let out = fmt.format(n);
  const override = SYMBOL_OVERRIDES[currency];
  if (override && !out.includes(override)) {
    // Normaliza "USD 1.234" / "$1,234" → "US$ 1.234" según locale
    out = out.replace(/(USD|US\$|\$)\s?/, `${override} `).replace(/  +/g, " ");
  }
  return out;
}

/** Parsea input humano según locale: es-AR/es-MX usan coma o punto decimal.
 *  "1.711.272,40" → 1711272.4 · "1,711,272.40" → 1711272.4 · "1234,5" → 1234.5 */
export function parseMoneyInput(raw: string): number | null {
  const s = raw.trim().replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const n = normalizeSeparators(s);
  return n != null && Number.isFinite(n) ? n : null;
}

/** Regla compartida es-AR/es-MX: con un solo separador, grupos de exactamente
 *  3 dígitos = miles ("152.430" → 152430, "1,234" → 1234); si no, decimal
 *  ("1234,5" → 1234.5). Con ambos, el que aparece último es el decimal. */
export function normalizeSeparators(s: string): number | null {
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

/** Suma montos agrupando por moneda. Devuelve un bucket por moneda presente. */
export function sumByCurrency(
  rows: Array<{ amount: number | string; currency: string }>
): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const r of rows) {
    const n = typeof r.amount === "string" ? Number(r.amount) : r.amount;
    if (!Number.isFinite(n)) continue;
    acc[r.currency] = Math.round(((acc[r.currency] ?? 0) + n) * 100) / 100;
  }
  return acc;
}

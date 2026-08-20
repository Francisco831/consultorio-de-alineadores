// Fechas de negocio con zona horaria EXPLÍCITA por empresa.
// NUNCA derivar "hoy" o "mes actual" de toISOString(): a las 22:30 de Buenos
// Aires ya es "mañana" en UTC y el bug es silencioso (lección del CRM).

function partsIn(tz: string, d: Date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // "YYYY-MM-DD"
}

/** Fecha de hoy (YYYY-MM-DD) en la TZ dada. */
export function todayIn(tz: string): string {
  return partsIn(tz);
}

/** Primer día del mes actual (YYYY-MM-01) en la TZ dada. */
export function monthStartIn(tz: string): string {
  return `${partsIn(tz).slice(0, 7)}-01`;
}

/** "2026-08" del mes actual en la TZ dada. */
export function currentPeriodIn(tz: string): string {
  return partsIn(tz).slice(0, 7);
}

/** Formatea una fecha ISO (YYYY-MM-DD) para mostrar, sin sorpresas de TZ. */
export function formatDateISO(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC", // la fecha se construyó como medianoche UTC: formatear en la TZ del proceso la corre un día
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "12 ago" corto para tablas. */
export function formatDateShort(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

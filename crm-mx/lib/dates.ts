/**
 * El negocio vive en America/Mexico_City. El servidor puede correr en cualquier
 * huso: NUNCA derivar "hoy" o "mes actual" de toISOString() (es UTC y corre el
 * límite del día/mes 6 horas antes).
 */
const MX_TZ = "America/Mexico_City";

/** YYYY-MM-DD de hoy en México */
export function todayMX(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MX_TZ }).format(new Date());
}

/** YYYY-MM-01 del mes actual en México */
export function monthStartMX(): string {
  return todayMX().slice(0, 7) + "-01";
}

/** Hora actual (0-23) en México — para saludos y cortes horarios */
export function hourMX(): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: MX_TZ,
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
}

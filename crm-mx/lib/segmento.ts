// El Estado de la cartera acreditada (migración 0058): la matriz Potencial ×
// Afinidad del Plan Comercial 2026. La casilla la calcula la base en
// doctors.segmento —desde el último caso que el doctor aprobó y su fecha de
// acreditación—; acá vive el texto que la explica: la acción asociada y el
// hecho del que sale, para que quien mira la lista sepa qué hacer y por qué.
// Nada de esto decide: describe.
import { SEGMENTO_ACCION, type Doctor } from "@/lib/types";

/** Días que tiene un beginner para aprobar su primer caso (Plan Comercial 2026). */
export const PLAZO_BEGINNER_DIAS = 90;

const DAY_MS = 86_400_000;

/** Días enteros de calendario entre dos fechas ISO (se queda con YYYY-MM-DD). */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round(
    (Date.parse(hasta.slice(0, 10)) - Date.parse(desde.slice(0, 10))) / DAY_MS
  );
}

/** "hoy", "ayer", "hace 12 días", "hace 7 meses", "hace 2 años" */
export function hace(dias: number): string {
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 30) return `hace ${dias} días`;
  if (dias < 365) {
    // 360-364 días darían "12 meses" y todavía no es un año: tope en 11
    const meses = Math.min(11, Math.floor(dias / 30));
    return `hace ${meses} ${meses === 1 ? "mes" : "meses"}`;
  }
  const anios = Math.floor(dias / 365);
  return `hace ${anios} ${anios === 1 ? "año" : "años"}`;
}

/**
 * La acción asociada al estado y el hecho del que sale, en una línea:
 *   activo   → "Defender · último caso aprobado hace 12 días"
 *   lapsed   → "Conquistar · último caso aprobado hace 7 meses"
 *   beginner → "Construir · 70 días para activarse"
 *   inactivo → "Observar · sin casos aprobados"
 * `hoy` es la fecha de México (lib/dates.ts), nunca la del servidor.
 */
export function explicarSegmento(
  d: Pick<Doctor, "segmento" | "ultimo_caso_aprobado_at" | "accredited_at">,
  hoy: string
): string {
  switch (d.segmento) {
    case "activo":
    case "lapsed": {
      const accion = SEGMENTO_ACCION[d.segmento];
      if (!d.ultimo_caso_aprobado_at) return accion;
      return `${accion} · último caso aprobado ${hace(diasEntre(d.ultimo_caso_aprobado_at, hoy))}`;
    }
    case "beginner": {
      if (!d.accredited_at) return SEGMENTO_ACCION.beginner;
      const quedan = Math.max(0, PLAZO_BEGINNER_DIAS - diasEntre(d.accredited_at, hoy));
      return `${SEGMENTO_ACCION.beginner} · ${quedan} ${quedan === 1 ? "día" : "días"} para activarse`;
    }
    case "inactivo":
      return `${SEGMENTO_ACCION.inactivo} · sin casos aprobados`;
    default:
      // la columna todavía no se calculó (migración sin aplicar o doctor recién cruzado)
      return "Todavía sin calcular";
  }
}

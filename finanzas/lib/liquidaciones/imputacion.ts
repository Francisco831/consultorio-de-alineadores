// A quién se le liquida cada cobro, cuando la caja no lo dice bien.
//
// La columna "doctora" de la caja anota quién estaba en el consultorio, no
// quién hizo el tratamiento. Cuando la paciente sólo pasa a RETIRAR sus
// alineadores o su contención no hay trabajo profesional detrás: esa plata no
// se le liquida a nadie y queda para la casa (regla de Pancho, 25/8/2026).
//
// La corrección vive en settlement_imputations (migración 0022) y este archivo
// es la única regla que la interpreta. Lo puro se prueba: imputacion.test.ts.

/**
 * movement_id → nombre de la doctora, o null = A NADIE (queda para la casa).
 *
 * La distinción que importa: `null` es una DECISIÓN ("esto no se liquida"),
 * mientras que la clave AUSENTE significa "lo que diga la caja". Por eso es un
 * Map y no un Record de nombres: `has` y `get` son cosas distintas acá.
 */
export type Imputaciones = Map<string, string | null>;

/** Quién cobra la liquidación de este movimiento: la corrección le gana a la caja. */
export function doctoraDeLiquidacion(
  movementId: string,
  doctoraCaja: string | null | undefined,
  imputaciones: Imputaciones
): string | null {
  if (imputaciones.has(movementId)) return imputaciones.get(movementId) ?? null;
  return doctoraCaja ?? null;
}

export type SettlementExistente = { id: string; doctora: string; periodo: string; status: string };

/** Confirmada o pagada: el recálculo no la toca ni para bien ni para mal. */
export function estaCongelada(status: string): boolean {
  return status === "confirmed" || status === "paid";
}

/**
 * Liquidaciones que quedaron SIN RESPALDO: existen en la base pero el cálculo
 * ya no genera ninguna línea para esa doctora en ese mes (le sacaron todos sus
 * cobros, o nunca los tuvo y sólo la sostenía un retiro que después se
 * reimputó a otro período). Se anulan; sin esto quedan de fantasma en el panel
 * mostrando números que ya no salen de ningún movimiento.
 */
export function liquidacionesSinRespaldo(
  existentes: SettlementExistente[],
  calculadas: Array<{ doctora: string; periodo: string }>,
  periodos: string[]
): SettlementExistente[] {
  const vivas = new Set(calculadas.map((c) => `${c.doctora}|${c.periodo}`));
  const alcance = new Set(periodos);
  return existentes.filter(
    (e) =>
      alcance.has(e.periodo) &&
      e.status !== "void" &&
      !estaCongelada(e.status) &&
      !vivas.has(`${e.doctora}|${e.periodo}`)
  );
}

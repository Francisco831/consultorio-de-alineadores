// A quién se le liquida cada cobro, y cuáles ya miró Pancho.
//
// La columna "doctora" de la caja anota quién estaba en el consultorio, no
// quién hizo el tratamiento. Cuando la paciente sólo pasa a RETIRAR sus
// alineadores o su contención no hay trabajo profesional detrás: esa plata no
// se le liquida a nadie y queda para la casa (regla de Pancho, 25/8/2026).
//
// La decisión vive en settlement_imputations (migraciones 0022 y 0023) y este
// archivo es la única regla que la interpreta. Lo puro se prueba:
// imputacion.test.ts.

/** Qué se decidió sobre un cobro. Sin fila, nadie lo miró todavía. */
export type Decision = {
  /** caja = como viene · casa = a nadie · profesional = a `doctora` */
  destino: "caja" | "casa" | "profesional";
  doctora: string | null;
  /** Ya lo miró: sirve para no volver a revisarlo, no cambia un peso. */
  revisado: boolean;
};

export type Imputaciones = Map<string, Decision>;

/**
 * Quién cobra la liquidación de este movimiento.
 *
 * Ojo con el destino "caja": no es lo mismo que no tener fila. Las dos cosas
 * liquidan igual, pero la fila existe porque Pancho miró la línea y la dejó
 * como estaba — y eso hay que poder verlo el mes que viene.
 */
export function doctoraDeLiquidacion(
  movementId: string,
  doctoraCaja: string | null | undefined,
  imputaciones: Imputaciones
): string | null {
  const d = imputaciones.get(movementId);
  if (!d || d.destino === "caja") return doctoraCaja ?? null;
  return d.destino === "casa" ? null : d.doctora;
}

/** Si esta línea ya la revisó (con o sin cambio). */
export function estaRevisado(movementId: string, imputaciones: Imputaciones): boolean {
  return imputaciones.get(movementId)?.revisado ?? false;
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

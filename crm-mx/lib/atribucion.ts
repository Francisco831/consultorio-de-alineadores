/**
 * Atribución de casos a personas del equipo.
 *
 * POR QUÉ NO SIRVE doctors.owner_id (que era como se contaba hasta el 2/9/26):
 * owner_id es el estado de HOY, no un registro de quién trabajó al doctor cuando
 * entró el caso. El 23/8 se le asignó a Rocío la cartera accionable (139
 * doctores) y con eso los casos de TODOS los meses —incluso los de enero, cuando
 * ella todavía no estaba— pasaron a contar para ella. Juan quedaba en 0 casos
 * todos los meses aunque había tocado 126 doctores: de esos, 78 tienen a Rocío
 * de owner y 45 no tienen owner. Reasignar una cartera reescribía la historia.
 *
 * LA REGLA: un caso se le cuenta a quien tocó a ese doctor por última vez dentro
 * de los VENTANA_DIAS anteriores a que el caso entrara. Sin contacto registrado
 * en la ventana, el caso queda SIN ATRIBUIR — y eso se muestra, no se reparte.
 * Rellenar el hueco con el owner devuelve el sesgo por la ventana (le daría a
 * Rocío 14 casos de enero de 2026).
 *
 * Ojo con el alcance: solo hay actividad cargada por persona desde 2026-01
 * (Juan) y 2026-05 (Rocío). Antes de eso todo queda sin atribuir, que es la
 * verdad: no hay registro de quién lo trabajó.
 */

/** Días hacia atrás desde el caso en los que un contacto se lleva el crédito. */
export const VENTANA_ATRIBUCION_DIAS = 90;

/**
 * Qué cuenta como "tocar" a un doctor. Deliberadamente afuera:
 *   · nota            → enriquecimiento importado, no es trabajo de nadie
 *   · revision_clinica → pedido de modificación QUE HACE EL DOCTOR, no el equipo
 *   · email           → no se usa en MX
 */
export const TIPOS_CONTACTO = [
  "llamada",
  "videollamada",
  "whatsapp",
  "visita",
  "reunion",
  "keepday",
] as const;

export type ToqueCrudo = {
  doctor_id: string;
  created_by: string | null;
  occurred_at: string;
};

export type CasoAtribuible = {
  doctor_id: string;
  fecha_ingreso: string;
};

/** doctor_id → sus toques ordenados por fecha (ms epoch + quién) */
export type IndiceToques = Map<string, { ts: number; by: string }[]>;

export function indiceDeToques(toques: ToqueCrudo[]): IndiceToques {
  const idx: IndiceToques = new Map();
  for (const t of toques) {
    if (!t.created_by) continue;
    let lista = idx.get(t.doctor_id);
    if (!lista) idx.set(t.doctor_id, (lista = []));
    lista.push({ ts: Date.parse(t.occurred_at), by: t.created_by });
  }
  for (const lista of idx.values()) lista.sort((a, b) => a.ts - b.ts);
  return idx;
}

/** Quién se lleva el caso, o null si nadie lo tocó dentro de la ventana. */
export function atribuirCaso(
  caso: CasoAtribuible,
  idx: IndiceToques,
  ventanaDias: number = VENTANA_ATRIBUCION_DIAS
): string | null {
  const lista = idx.get(caso.doctor_id);
  if (!lista) return null;
  const t = Date.parse(caso.fecha_ingreso);
  const piso = t - ventanaDias * 86_400_000;
  // ordenada por fecha: el último que entra dentro de la ventana es el que vale
  let quien: string | null = null;
  for (const toque of lista) {
    if (toque.ts > t) break;
    if (toque.ts >= piso) quien = toque.by;
  }
  return quien;
}

export function contarCasosPorPersona(
  casos: CasoAtribuible[],
  idx: IndiceToques,
  ventanaDias: number = VENTANA_ATRIBUCION_DIAS
): { porPersona: Map<string, number>; sinAtribuir: number } {
  const porPersona = new Map<string, number>();
  let sinAtribuir = 0;
  for (const c of casos) {
    const quien = atribuirCaso(c, idx, ventanaDias);
    if (!quien) sinAtribuir++;
    else porPersona.set(quien, (porPersona.get(quien) ?? 0) + 1);
  }
  return { porPersona, sinAtribuir };
}

/** ISO del borde inferior de actividades a traer para atribuir casos desde `desdeISO`. */
export function desdeConVentana(
  desdeISO: string,
  ventanaDias: number = VENTANA_ATRIBUCION_DIAS
): string {
  return new Date(Date.parse(desdeISO) - ventanaDias * 86_400_000).toISOString();
}

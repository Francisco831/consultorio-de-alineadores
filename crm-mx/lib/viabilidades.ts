// Lo que muestra /viabilidades, sin Supabase: qué filas son viabilidades, en
// qué estado están, qué número del mes les toca y si matchean un buscador.
// Vive aparte de la página para poder testearlo, y porque los NOMBRES de los
// estados los está cerrando el equipo (pedido del 8/9/26): se cambian en
// ESTADOS y en ningún otro lado — la página no tiene texto de estados propio.

import type { ViabilityStatus } from "@/lib/types";

/** Una fila de `opportunities` con lo que la pestaña necesita (ver el select en la página). */
export interface ViabilidadFila {
  id: string;
  stage: string;
  patient_name: string | null;
  case_id: string | null;
  lost_reason: string | null;
  closed_at: string | null;
  created_at: string;
  stage_entered_at: string | null;
  viability_requested_at: string | null;
  viability_status: ViabilityStatus | null;
  doctors: { id: string; nombre: string } | null;
  /** quien la cargó: `owner_id` → profiles (las 38 del import no tienen) */
  asesor: { nombre: string } | null;
  cases: { id_externo: string | null } | null;
}

// QUÉ ES UNA VIABILIDAD, en los datos. No hay columna que lo diga. Las 38 que
// existen entraron en el import del 8/8/26 y se reconocen por dónde quedaron:
// las abiertas están en la etapa 'viabilidad', las que no llegaron a caso las
// cerró el reloj del import con lost_reason 'Viabilidad no convertida', y las
// que sí llegaron quedaron en 'ganada' con case_id. Las que se carguen de acá
// en adelante traen `viability_requested_at`, que es la marca de verdad y no
// una inferencia — con el tiempo el criterio legacy se puede retirar.
export const LOST_VIABILIDAD = "Viabilidad no convertida";

export function esViabilidad(o: ViabilidadFila): boolean {
  return (
    o.viability_requested_at != null ||
    o.stage === "viabilidad" ||
    o.lost_reason === LOST_VIABILIDAD ||
    (o.stage === "ganada" && o.case_id != null)
  );
}

/** Fecha de ingreso: cuándo se pidió. Si nadie lo cargó, cuándo entró a la etapa. */
export function fechaIngreso(o: ViabilidadFila): string {
  return o.viability_requested_at ?? o.stage_entered_at ?? o.created_at;
}

// ---------------------------------------------------------------------------
// Estado. Las dos primeras son la misma cosa vista con el reloj: abierta y
// nueva, o abierta y ya vieja. Las otras dos son cómo terminó.
// ---------------------------------------------------------------------------
export type EstadoViabilidad =
  | "esperando"
  | "seguimiento"
  | "suspendida"
  | "convertida";

export const ORDEN_ESTADOS: EstadoViabilidad[] = [
  "esperando",
  "seguimiento",
  "suspendida",
  "convertida",
];

/** Desde el ingreso: hasta 7 días es "esperando"; superados los 7, "seguimiento". */
export const DIAS_SEMANA = 7;

export const ESTADOS: Record<
  EstadoViabilidad,
  { label: string; ayuda: string; clase: string }
> = {
  esperando: {
    label: "Esperando respuesta",
    ayuda: "Ingresó hace 7 días o menos y todavía no se resolvió.",
    clase:
      "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-900",
  },
  seguimiento: {
    label: "Seguimiento",
    ayuda: "Pasó más de una semana desde el ingreso y sigue sin resolverse.",
    clase:
      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-900",
  },
  suspendida: {
    label: "Suspendido",
    ayuda: "Se cerró sin caso: se dio por perdida o quedó sin respuesta.",
    clase: "bg-muted text-muted-foreground border-transparent",
  },
  convertida: {
    label: "Convertido",
    ayuda: "Terminó en un caso ingresado.",
    clase:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-900",
  },
};

export function dias(desde: string, ahora: number = Date.now()): number {
  return Math.floor((ahora - Date.parse(desde)) / 86_400_000);
}

export function estadoDe(
  o: ViabilidadFila,
  ahora: number = Date.now()
): EstadoViabilidad {
  if (o.case_id != null || o.stage === "ganada") return "convertida";
  // `sin_respuesta` cierra el ciclo (lib/actions/viabilidad.ts): se dio por perdida
  if (o.stage === "perdida" || o.viability_status === "sin_respuesta")
    return "suspendida";
  return dias(fechaIngreso(o), ahora) > DIAS_SEMANA ? "seguimiento" : "esperando";
}

export function abierta(estado: EstadoViabilidad): boolean {
  return estado === "esperando" || estado === "seguimiento";
}

// ---------------------------------------------------------------------------
// Numeración mensual: 1, 2, 3… por orden de ingreso dentro de cada mes, y
// vuelve a 1 al mes siguiente. Se calcula, no se guarda: si alguien carga una
// viabilidad con fecha atrasada, se mete en el medio y las que siguen corren
// un lugar. Se numera el universo COMPLETO, nunca el resultado de un buscador.
// ---------------------------------------------------------------------------

/**
 * "YYYY-MM" de una fecha de ingreso. Se lee en UTC a propósito: la fecha del
 * formulario se guarda como medianoche UTC de ese día (lib/actions/opportunities.ts),
 * así que leerla en México la correría al día anterior — y el 1° de cada mes
 * caería en el mes de antes. No es "hoy" ni "mes actual": para eso, lib/dates.ts.
 */
export function mesDe(iso: string): string {
  return new Date(iso).toISOString().slice(0, 7);
}

export function numerar(filas: ViabilidadFila[]): Map<string, number> {
  const orden = filas.slice().sort((a, b) => {
    const fa = Date.parse(fechaIngreso(a));
    const fb = Date.parse(fechaIngreso(b));
    if (fa !== fb) return fa - fb;
    const ca = Date.parse(a.created_at);
    const cb = Date.parse(b.created_at);
    if (ca !== cb) return ca - cb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const porMes = new Map<string, number>();
  const numero = new Map<string, number>();
  for (const o of orden) {
    const mes = mesDe(fechaIngreso(o));
    const n = (porMes.get(mes) ?? 0) + 1;
    porMes.set(mes, n);
    numero.set(o.id, n);
  }
  return numero;
}

// ---------------------------------------------------------------------------
// Buscador: por subcadena, sin acentos ni mayúsculas ("hernandez" encuentra a
// "Hernández"). Un buscador vacío no filtra nada.
// ---------------------------------------------------------------------------
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function coincide(texto: string | null | undefined, q: string): boolean {
  const nq = normalizar(q);
  if (!nq) return true;
  return normalizar(texto ?? "").includes(nq);
}

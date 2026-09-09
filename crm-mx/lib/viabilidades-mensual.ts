// El panel mensual de /viabilidades (pedido de Pancho 8/9/26): cuántas
// viabilidades entraron cada mes, en qué estado están HOY y qué porcentaje
// convirtió, contra el objetivo de conversión de ese mes. No tiene datos
// propios: son las mismas filas y el mismo estadoDe() que la tabla de abajo,
// así que si el panel dice "3 en seguimiento" en agosto, al hacer click
// aparecen esas tres. Vive aparte para testearse sin Supabase.
//
// El mes de una viabilidad es el de su fecha de ingreso (mesDe, en UTC, por la
// misma razón que la numeración mensual). "Convertida" la escribe el sync de
// Noloco vía vincular_viabilidades() (migración 0057), no una persona.

import {
  ORDEN_ESTADOS,
  estadoDe,
  fechaIngreso,
  mesDe,
  type EstadoViabilidad,
  type ViabilidadFila,
} from "./viabilidades";

/** Métrica de `goals` con el objetivo de conversión del mes, en % (país: user_id null). */
export const METRICA_OBJETIVO_VIABILIDADES = "viability_conversion";

export interface MesViabilidades {
  /** "YYYY-MM" */
  mes: string;
  ingresadas: number;
  porEstado: Record<EstadoViabilidad, number>;
  /** convertidas sobre ingresadas, en % redondeado; null si no ingresó ninguna */
  tasa: number | null;
  /** objetivo de conversión del mes, en %; null si no está cargado en Ajustes */
  objetivo: number | null;
}

function sinNada(): Record<EstadoViabilidad, number> {
  return Object.fromEntries(ORDEN_ESTADOS.map((e) => [e, 0])) as Record<
    EstadoViabilidad,
    number
  >;
}

/** % redondeado, o null cuando no hay sobre qué calcularlo. */
export function tasaDe(convertidas: number, ingresadas: number): number | null {
  return ingresadas ? Math.round((convertidas / ingresadas) * 100) : null;
}

/** Los objetivos de `goals` (period "YYYY-MM-01", target en %) como mapa "YYYY-MM" → %. */
export function mapaObjetivos(
  goals: { period: string; target: number }[]
): Map<string, number> {
  return new Map(goals.map((g) => [g.period.slice(0, 7), g.target]));
}

export function esDelMes(o: ViabilidadFila, mes: string): boolean {
  return mesDe(fechaIngreso(o)) === mes;
}

/**
 * Un renglón por mes, del más nuevo al más viejo. Entra todo mes con alguna
 * viabilidad y además `mesActual` aunque esté vacío: el panel siempre arranca
 * en el mes en curso, con su objetivo a la vista.
 */
export function resumenMensual(
  filas: ViabilidadFila[],
  objetivos: ReadonlyMap<string, number>,
  mesActual: string,
  ahora: number = Date.now()
): MesViabilidades[] {
  const porMes = new Map<string, MesViabilidades>();
  const renglon = (mes: string): MesViabilidades => {
    let m = porMes.get(mes);
    if (!m) {
      m = {
        mes,
        ingresadas: 0,
        porEstado: sinNada(),
        tasa: null,
        objetivo: objetivos.get(mes) ?? null,
      };
      porMes.set(mes, m);
    }
    return m;
  };
  renglon(mesActual);
  for (const o of filas) {
    const m = renglon(mesDe(fechaIngreso(o)));
    m.ingresadas++;
    m.porEstado[estadoDe(o, ahora)]++;
  }
  for (const m of porMes.values()) {
    m.tasa = tasaDe(m.porEstado.convertida, m.ingresadas);
  }
  return [...porMes.values()].sort((a, b) =>
    a.mes < b.mes ? 1 : a.mes > b.mes ? -1 : 0
  );
}

/** La suma de todos los meses del panel (sin objetivo: no hay uno "total"). */
export function totalMensual(
  meses: MesViabilidades[]
): Pick<MesViabilidades, "ingresadas" | "porEstado" | "tasa"> {
  const porEstado = sinNada();
  let ingresadas = 0;
  for (const m of meses) {
    ingresadas += m.ingresadas;
    for (const e of ORDEN_ESTADOS) porEstado[e] += m.porEstado[e];
  }
  return { ingresadas, porEstado, tasa: tasaDe(porEstado.convertida, ingresadas) };
}

/** Cómo le fue al mes contra su objetivo. null cuando no hay con qué comparar. */
export function contraObjetivo(
  m: Pick<MesViabilidades, "tasa" | "objetivo">
): "cumple" | "no_cumple" | null {
  if (m.objetivo == null || m.tasa == null) return null;
  return m.tasa >= m.objetivo ? "cumple" : "no_cumple";
}

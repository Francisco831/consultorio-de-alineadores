// El tipo de cambio del sistema: dólar blue de Ámbito, promedio compra/venta.
//
// REGLA (Pancho, 25/8/2026): todo lo que entra en dólares se pesifica al blue
// de SU fecha, y el t/c es el punto medio entre comprador y vendedor — no el
// que alguien haya anotado a mano en la caja. Una sola fuente para todo el
// sistema: si cada liquidación usara el t/c que trae escrito su fila, dos
// cobros del mismo día podrían valer distinto y nadie podría reconstruir por
// qué. La fuente es Ámbito (dolar-informal-historico) porque es la que Pancho
// venía usando en su planilla; DolarHoy no publica una serie histórica
// consultable (su sitio devuelve 200 a cualquier URL y sirve páginas cacheadas
// de días anteriores, verificado el 25/8/2026).

import { normalizeSeparators } from "./money";

export const FUENTE_TC = "ambito_informal";

export type Cotizacion = { fecha: string; compra: number; venta: number };

/** El t/c de una cotización: punto medio entre compra y venta. */
export function tcDe(c: { compra: number; venta: number }): number {
  return (c.compra + c.venta) / 2;
}

/** URL del histórico de Ámbito para un rango (fechas ISO). */
export function urlAmbito(desde: string, hasta: string): string {
  const ar = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  return `https://mercados.ambito.com//dolar/informal/historico-general/${ar(desde)}/${ar(hasta)}`;
}

/**
 * Parsea la respuesta de Ámbito: [["Fecha","Compra","Venta"], ["30/07/2026","1550,00",...]].
 *
 * Ámbito publica varias veces por día y el histórico los devuelve TODOS, del
 * más reciente al más viejo. De un día repetido vale la primera aparición, que
 * es la última publicación: el cierre. (Julio 2026 trae dos 17/07 y dos 24/07.)
 */
export function parseAmbito(filas: unknown): Cotizacion[] {
  if (!Array.isArray(filas)) throw new Error("Ámbito: respuesta que no es una lista");
  const out: Cotizacion[] = [];
  const vistas = new Set<string>();
  for (const f of filas) {
    if (!Array.isArray(f) || f.length < 3) continue;
    const [fechaRaw, compraRaw, ventaRaw] = f.map((x) => String(x));
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fechaRaw.trim());
    if (!m) continue;   // la fila de encabezados
    const fecha = `${m[3]}-${m[2]}-${m[1]}`;
    if (vistas.has(fecha)) continue;
    const compra = normalizeSeparators(compraRaw.replace(/[^\d.,-]/g, ""));
    const venta = normalizeSeparators(ventaRaw.replace(/[^\d.,-]/g, ""));
    if (compra == null || venta == null || compra <= 0 || venta <= 0) continue;
    vistas.add(fecha);
    out.push({ fecha, compra, venta });
  }
  if (!out.length) throw new Error("Ámbito: ninguna cotización parseable en la respuesta");
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export type TablaTC = {
  /** t/c de esa fecha, o el de la última rueda anterior. undefined si no hay ninguna. */
  (fecha: string): number | undefined;
  /** De qué fecha salió el t/c que devolvió: para poder decirlo en la liquidación. */
  fechaUsada(fecha: string): string | undefined;
};

/**
 * Arma el buscador de t/c. Sábados, domingos y feriados no tienen rueda: se
 * arrastra la última cotización anterior — es lo que valía el dólar cuando se
 * cobró. Una fecha anterior a toda la serie no se completa hacia atrás: eso
 * sería inventar, y el que llama decide qué hacer.
 */
export function tablaTC(cotizaciones: Cotizacion[]): TablaTC {
  const orden = [...cotizaciones].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const buscar = (fecha: string): Cotizacion | undefined => {
    let hit: Cotizacion | undefined;
    for (const c of orden) {
      if (c.fecha > fecha) break;
      hit = c;
    }
    return hit;
  };
  const fn = ((fecha: string) => {
    const c = buscar(fecha);
    return c ? tcDe(c) : undefined;
  }) as TablaTC;
  fn.fechaUsada = (fecha: string) => buscar(fecha)?.fecha;
  return fn;
}

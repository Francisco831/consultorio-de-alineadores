// Lectura COMPLETA de una tabla vía PostgREST.
//
// PostgREST corta cualquier SELECT en 1.000 filas por default y NO avisa: la
// respuesta llega sin error y con menos datos. Con 7.100 doctores y 1.051 pagos
// eso hace que un sync "no encuentre" lo que ya existe y lo duplique, o que un
// match compare contra un universo parcial.
//
// Gemelo de scripts/lib/fetch-all.ts, que no se puede importar desde el build de
// Next (vive fuera de él). Si se toca uno, tocar el otro.

import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = 1000;

export async function traerTodo<T>(
  db: SupabaseClient,
  tabla: string,
  columnas: string,
  afinar?: (q: never) => never
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    // El orden explícito NO es cosmético: cada página es una query independiente
    // y Postgres no garantiza orden estable sin ORDER BY, así que sin esto una
    // fila puede venir dos veces y otra ninguna — justo el agujero que esta
    // función existe para tapar.
    let q = db.from(tabla).select(columnas).order("id").range(from, from + PAGE - 1);
    if (afinar) q = afinar(q as never);
    const { data, error } = await q;
    if (error) throw new Error(`lectura de ${tabla}: ${error.message}`);
    const filas = (data ?? []) as unknown as T[];
    out.push(...filas);
    if (filas.length < PAGE) return out;
  }
}

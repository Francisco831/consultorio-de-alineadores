/**
 * fetchAll — lectura COMPLETA de una tabla vía PostgREST.
 *
 * PostgREST (Supabase) corta cualquier SELECT en 1.000 filas por default y NO
 * avisa: la respuesta llega sin error y con menos datos. Con 6.4k doctores eso
 * hace que un import "no encuentre" a los existentes y los duplique, o que un
 * dedupe compare contra un universo parcial.
 *
 * Esta función pagina con .range() hasta traer todo. Usar SIEMPRE que el
 * resultado se use para matchear/deduplicar/contar.
 *
 *   const doctors = await fetchAll(db, "doctors", "id, noloco_id, nombre");
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = 1000;

export async function fetchAll<T = Record<string, unknown>>(
  db: SupabaseClient,
  table: string,
  columns: string,
  tweak?: (q: any) => any
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select(columns).range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAll(${table}): ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

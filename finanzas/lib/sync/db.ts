// Ayudantes de escritura/lectura masiva contra Supabase, sin nada de terminal:
// los usan igual los scripts (scripts/lib/service-client.ts los re-exporta) y
// el cron de Vercel, que corre el MISMO código.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Cliente service-role. En Vercel las variables vienen del proyecto. */
export function clienteServicio(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Inserta en tandas de a 500 con upsert idempotente. */
export async function upsertBatched(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  opts: { ignoreDuplicates?: boolean } = {}
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db
      .from(table)
      .upsert(chunk, { onConflict, ignoreDuplicates: opts.ignoreDuplicates ?? false });
    if (error) {
      throw new Error(`upsert ${table} (fila ~${i}): ${error.message}`);
    }
    written += chunk.length;
  }
  return written;
}

/** SELECT paginado de a 1.000 (PostgREST corta en 1.000 SIN avisar). */
// el builder de PostgREST es un genérico intratable; el filtro solo encadena .eq/.neq/.in
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FilterFn = (q: any) => any;

export async function fetchAllRows<T>(
  db: SupabaseClient,
  table: string,
  select: string,
  filter: FilterFn
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const q = filter(db.from(table).select(select).range(from, from + page - 1));
    const { data, error } = await q;
    if (error) throw new Error(`select ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) break;
  }
  return out;
}

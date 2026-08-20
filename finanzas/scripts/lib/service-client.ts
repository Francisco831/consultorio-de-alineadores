// Cliente service-role para seeds e importadores de terminal.
// TODO script que escriba pasa antes por confirmarDestino() (guard heredado del
// CRM): anuncia contra qué base va a escribir y exige confirmación proporcional
// al riesgo. Producción exige confirmación escrita SIEMPRE.

import { config } from "dotenv";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { confirmarDestino, type OpcionesDestino } from "./destino";

config({ path: resolve(__dirname, "../../.env.local") });

export async function serviceClient(opciones: OpcionesDestino): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local"
    );
  }
  await confirmarDestino(opciones);
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

export function argFlags() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes("--apply"),
    yes: args.includes("--yes"),
    dryRun: !args.includes("--apply"),
  };
}

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

// upsertBatched/fetchAllRows viven en lib/sync/db.ts: los comparte con el cron
// de Vercel, que corre el mismo importador.
export { upsertBatched, fetchAllRows } from "../../lib/sync/db";

export function argFlags() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes("--apply"),
    yes: args.includes("--yes"),
    dryRun: !args.includes("--apply"),
  };
}

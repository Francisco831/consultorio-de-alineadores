// Siembra alerta_rechazos_estado con el estado local de la Mac de Pancho
// (~/ks-alertas/alerta_estado.json — los casos que el launchd ya avisó), para
// que el cron cloud (/api/sync/alerta) no re-avise el backlog. Correr UNA vez,
// después de aplicar la migración 0037:
//
//   npx tsx scripts/seed-alerta-estado.ts
//
// Idempotente: upsert por caso, se queda con el máximo de rechazos.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { config } from "dotenv";

config({ path: resolve(__dirname, "../.env.local") });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(1);
}

async function main() {
  const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
  const local: Record<string, number> = JSON.parse(
    readFileSync(resolve(homedir(), "ks-alertas/alerta_estado.json"), "utf8")
  );
  const { data: filas, error: e1 } = await db.from("alerta_rechazos_estado").select("caso, rechazos");
  if (e1) throw new Error(e1.message);
  const previo = new Map((filas ?? []).map((f) => [f.caso as string, f.rechazos as number]));
  const upserts = Object.entries(local).map(([caso, rechazos]) => ({
    caso,
    rechazos: Math.max(rechazos, previo.get(caso) ?? 0),
    updated_at: new Date().toISOString(),
  }));
  const { error: e2 } = await db.from("alerta_rechazos_estado").upsert(upserts, { onConflict: "caso" });
  if (e2) throw new Error(e2.message);
  console.log(`Sembrados ${upserts.length} casos (la tabla tenía ${previo.size}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });

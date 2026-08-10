/**
 * Vuelca data/ficha_tipos.json (tipos comerciales derivados de la ficha de
 * entregas) sobre cases, matcheando por id_externo.
 *   npx tsx scripts/import-ficha.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

interface FichaRow {
  id_externo: string;
  tipo_caso: string | null;
  alineadores_total: number | null;
  entregas: number;
}

async function main() {
  const rows: FichaRow[] = JSON.parse(
    readFileSync(resolve(__dirname, "../data/ficha_tipos.json"), "utf8")
  );
  const { data: cases, error } = await db
    .from("cases")
    .select("id, id_externo")
    .not("id_externo", "is", null);
  if (error) throw error;
  const byExterno = new Map(
    (cases ?? []).map((c) => [String(c.id_externo).toUpperCase(), c.id])
  );

  const updates = rows
    .filter((r) => r.tipo_caso && byExterno.has(r.id_externo))
    .map((r) => ({
      id: byExterno.get(r.id_externo)!,
      tipo_caso: r.tipo_caso,
      alineadores_total: r.alineadores_total,
      entregas: r.entregas,
    }));

  let done = 0;
  for (let i = 0; i < updates.length; i += 20) {
    await Promise.all(
      updates.slice(i, i + 20).map(async (u) => {
        const { error: uErr } = await db
          .from("cases")
          .update({
            tipo_caso: u.tipo_caso,
            alineadores_total: u.alineadores_total,
            entregas: u.entregas,
          })
          .eq("id", u.id);
        if (uErr) throw uErr;
      })
    );
    done += Math.min(20, updates.length - i);
  }
  console.log(
    `Ficha → cases: ${done} casos tipificados de ${rows.length} IDs en ficha ` +
      `(${rows.length - updates.length} sin match en Noloco, mayormente pre-2024-09)`
  );

  await db.from("sync_runs").insert({
    source: "ficha_entregas",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    rows_upserted: done,
    status: "ok",
    log: { ids_ficha: rows.length, matcheados: updates.length },
  });
  console.log("Ficha OK ✓");
}

main().catch((e) => {
  console.error("Import falló:", e);
  process.exit(1);
});

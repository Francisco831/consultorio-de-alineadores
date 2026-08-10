/**
 * Baja de Itzel (no trabaja más): reasigna cualquier referencia suya a Juan
 * y elimina su usuario de auth (el profile cae en cascada).
 * Idempotente: si no existe, no hace nada.
 *   npx tsx scripts/remove-itzel.ts   (usa NEXT_PUBLIC_SUPABASE_URL/SERVICE_ROLE de env)
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  const { data: profs, error } = await db.from("profiles").select("id, nombre");
  if (error) throw error;
  const itzel = (profs ?? []).find((p) => /itzel/i.test(p.nombre));
  const juan = (profs ?? []).find((p) => /juan/i.test(p.nombre));
  if (!itzel) {
    console.log("sin Itzel — nada que hacer");
    return;
  }
  if (!juan) throw new Error("no encontré a Juan para reasignar");

  const refs: [string, string][] = [
    ["doctors", "owner_id"],
    ["doctors", "clinical_owner_id"],
    ["opportunities", "owner_id"],
    ["tasks", "assigned_to"],
    ["tasks", "created_by"],
    ["activities", "created_by"],
    ["alerts", "resolved_by"],
    ["goals", "user_id"],
    ["segments", "owner_id"],
  ];
  for (const [table, col] of refs) {
    const { count } = await db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq(col, itzel.id);
    if (count) {
      const { error: e } = await db
        .from(table)
        .update({ [col]: juan.id })
        .eq(col, itzel.id);
      if (e) throw new Error(`${table}.${col}: ${e.message}`);
      console.log(`  reasignado a Juan: ${table}.${col} (${count})`);
    }
  }
  const { error: delErr } = await db.auth.admin.deleteUser(itzel.id);
  if (delErr) throw delErr;
  console.log("Itzel eliminada ✓");
}

main().catch((e) => {
  console.error("Falló:", e);
  process.exit(1);
});

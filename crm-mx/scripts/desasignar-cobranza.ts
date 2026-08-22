/**
 * Saca de la agenda de Rocío las tareas de COBRANZA ("Cobrar …"): Rocío no
 * cobra (Pancho, 22/8). Quedan `assigned_to = null` — siguen pendientes y
 * visibles en /tareas, sin dueño, hasta que se decida quién cobra (¿Juan?
 * ¿Angélica cuando tenga usuario?) o qué hacer con el lote muerto del 8/8.
 *
 *   npx tsx scripts/desasignar-cobranza.ts            lista lo que haría (no escribe)
 *   npx tsx scripts/desasignar-cobranza.ts --aplicar  desasigna de verdad
 *
 * Reversible: imprime los ids afectados; re-asignar es un update con esa lista.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  const dry = !process.argv.includes("--aplicar");

  const { data: rocio, error: ep } = await db
    .from("profiles")
    .select("id, nombre")
    .ilike("nombre", "roc%")
    .single();
  if (ep || !rocio) throw new Error(`no encontré el perfil de Rocío: ${ep?.message}`);

  const { data: tareas, error: et } = await db
    .from("tasks")
    .select("id, title, due_date")
    .eq("assigned_to", rocio.id)
    .eq("status", "pendiente")
    .ilike("title", "cobrar%");
  if (et) throw new Error(et.message);

  console.log(`${rocio.nombre} tiene ${tareas?.length ?? 0} tareas "Cobrar…" pendientes:`);
  for (const t of tareas ?? [])
    console.log(`  - [${t.due_date ?? "sin fecha"}] ${t.title.slice(0, 80)}  (${t.id})`);
  if (!tareas?.length) return;

  if (dry) {
    console.log("\n  (no se cambió nada — agregá --aplicar para desasignarlas)");
    return;
  }

  await confirmarDestino({
    accion: `desasignar ${tareas.length} tareas de cobranza de ${rocio.nombre} (quedan sin responsable, siguen pendientes)`,
  });

  const { error: eu, count } = await db
    .from("tasks")
    .update({ assigned_to: null }, { count: "exact" })
    .in(
      "id",
      tareas.map((t) => t.id)
    );
  if (eu) throw new Error(eu.message);
  console.log(`\nListo: ${count} tareas desasignadas.`);
}

main().catch((e) => {
  salirConDestinoRechazado(e);
});

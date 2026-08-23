/**
 * Backfill de autoría de activities (bug perfilPorPista, arreglado 22/8): el
 * sync histórico entró TODO con created_by null. Reparte lo que tiene dueño
 * claro y deja el resto como está:
 *
 *   · visita/reunion/whatsapp/keepday sin autor → Juan   (contact points de SU
 *     login del intranet; ~395)
 *   · llamada sin autor                         → Rocío  (import del sheet
 *     data/llamadas_rocio.json; 58)
 *   · nota (enriquecimiento) y revision_clinica (pedidos del doctor) quedan
 *     sin autor A PROPÓSITO: no son trabajo de nadie del equipo.
 *
 *   npx tsx scripts/backfill-autoria.ts            muestra qué haría (no escribe)
 *   npx tsx scripts/backfill-autoria.ts --aplicar  escribe (pide confirmar destino)
 *
 * Idempotente: la segunda corrida encuentra 0 filas sin autor.
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

const GRUPOS = [
  {
    perfilPista: "juan%",
    tipos: ["visita", "reunion", "whatsapp", "keepday"],
    porQue: "contact points del intranet (login de Juan)",
  },
  {
    perfilPista: "roc%",
    tipos: ["llamada"],
    porQue: "llamadas importadas del sheet de Rocío",
  },
];

async function main() {
  const dry = !process.argv.includes("--aplicar");

  const { data: perfiles, error: ep } = await db
    .from("profiles")
    .select("id, nombre");
  if (ep) throw new Error(ep.message);

  const plan: { perfil: { id: string; nombre: string }; tipos: string[]; n: number; porQue: string }[] = [];
  for (const g of GRUPOS) {
    const perfil = (perfiles ?? []).find((p) =>
      p.nombre.toLowerCase().startsWith(g.perfilPista.replace("%", ""))
    );
    if (!perfil) throw new Error(`no encontré el perfil para ${g.perfilPista}`);
    const { count, error } = await db
      .from("activities")
      .select("id", { count: "exact", head: true })
      .is("created_by", null)
      .eq("is_demo", false)
      .in("type", g.tipos);
    if (error) throw new Error(error.message);
    plan.push({ perfil, tipos: g.tipos, n: count ?? 0, porQue: g.porQue });
  }

  console.log("Backfill de autoría — actividades sin autor:");
  for (const p of plan)
    console.log(
      `  ${String(p.n).padStart(4)} × [${p.tipos.join(", ")}] → ${p.perfil.nombre}  (${p.porQue})`
    );

  if (plan.every((p) => p.n === 0)) {
    console.log("\nNada para hacer: no quedan filas sin autor en esos tipos.");
    return;
  }
  if (dry) {
    console.log("\n  (no se cambió nada — agregá --aplicar para ejecutarlo)");
    return;
  }

  await confirmarDestino({
    accion: `poner autor a ${plan.reduce((a, p) => a + p.n, 0)} actividades históricas (${plan
      .map((p) => `${p.n}→${p.perfil.nombre}`)
      .join(", ")})`,
  });

  for (const p of plan) {
    if (p.n === 0) continue;
    const { error, count } = await db
      .from("activities")
      .update({ created_by: p.perfil.id }, { count: "exact" })
      .is("created_by", null)
      .eq("is_demo", false)
      .in("type", p.tipos);
    if (error) throw new Error(error.message);
    console.log(`  ✓ ${count} actividades → ${p.perfil.nombre}`);
  }
  console.log("\nListo. Verificá en Equipo → Actividad o en los paneles.");
}

main().catch((e) => {
  salirConDestinoRechazado(e);
});

/**
 * Dry-run de la capa AI sobre un doctor real — SIN llamar al modelo y sin gastar
 * un token. Muestra exactamente lo que vería el agente: el ruteo determinístico
 * con su evidencia, el bloque de contexto y el system prompt del agente primario.
 *
 *   npx tsx scripts/ai-dryrun-doctor.ts "apellido o nombre"
 *   npx tsx scripts/ai-dryrun-doctor.ts <uuid> --brain     (agrega el Brain completo)
 *
 * Es de solo lectura. Usa la conexión de servicio (no hay sesión en un script),
 * así que sirve para auditar, no para probar RLS.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { buildDoctorContext, contextToPromptBlock } from "@/lib/ai/context";
import { routeDoctor } from "@/lib/ai/orchestrator";
import { createAiServiceClient } from "@/lib/ai/db";
import { dataConfidence } from "@/lib/ai/confidence";
import { AGENTS } from "@/lib/ai/agents";
import { getBrainSections, BRAIN_VERSION } from "@/lib/ai/brain";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = process.argv.slice(2);
  const conBrain = args.includes("--brain");
  const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!query) {
    console.error('Uso: npx tsx scripts/ai-dryrun-doctor.ts "nombre o uuid" [--brain]');
    process.exit(1);
  }

  const db = createAiServiceClient();
  let id = query;
  if (!UUID.test(query)) {
    const { data, error } = await db
      .from("doctors")
      .select("id, nombre, is_accredited, lifecycle_stage")
      .ilike("nombre", `%${query}%`)
      .order("is_accredited", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    if (!data?.length) {
      console.error(`Ningún doctor coincide con "${query}".`);
      process.exit(1);
    }
    if (data.length > 1) {
      console.error(`${data.length} coincidencias — precisá el nombre o pasá el uuid:`);
      for (const d of data)
        console.error(`  ${d.id}  ${d.nombre}  (${d.is_accredited ? "acreditado" : "prospecto"}, ${d.lifecycle_stage})`);
      process.exit(1);
    }
    id = data[0].id as string;
  }

  const ctx = await buildDoctorContext(id, db);
  const routing = routeDoctor(ctx);
  const conf = dataConfidence(ctx);
  const primary = routing.primary?.agent ?? null;
  const spec = primary ? AGENTS[primary] : null;

  const out: string[] = [];
  out.push(`# ${ctx.name}   ·   Brain ${BRAIN_VERSION}`);
  out.push("");
  out.push("## Ruteo determinístico (código, sin modelo)");
  out.push(`- PRIMARIO: ${primary ?? "ninguno"}`);
  out.push(`- APOYO: ${routing.supporting.map((s) => s.agent).join(", ") || "—"}`);
  out.push(`- MOTIVO: ${routing.routing_reason}`);
  out.push(`- CONFIANZA DE DATOS: ${conf.score}/100`);
  for (const cap of conf.caps) out.push(`  · tope: ${cap}`);
  out.push("");
  out.push("## Evidencia del ruteo");
  for (const e of routing.routing_evidence) out.push(`- ${e.field} = ${e.value}  (fuente: ${e.source})`);
  out.push("");
  out.push("## Bloque de contexto (lo que recibe el modelo)");
  out.push(contextToPromptBlock(ctx));
  if (spec) {
    out.push("");
    out.push(`## System prompt del agente primario (${primary})`);
    out.push(spec.systemPrompt);
    if (conBrain) {
      out.push("");
      out.push("## Brain cargado para este agente");
      out.push(getBrainSections(spec.brainSections));
    }
  }
  console.log(out.join("\n"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

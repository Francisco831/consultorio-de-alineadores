/**
 * Corrida REAL de la capa AI sobre un doctor. **Llama al modelo y gasta tokens.**
 *
 *   npx tsx scripts/ai-correr-doctor.ts "apellido o uuid"
 *   npx tsx scripts/ai-correr-doctor.ts <uuid> --json     (además vuelca el emit crudo)
 *
 * Para ver qué haría SIN gastar un token: scripts/ai-dryrun-doctor.ts
 *
 * POR QUÉ EXISTE. Hasta el 11/8/2026 la capa AI nunca había corrido: `agent_runs`
 * tenía 0 filas en las dos bases. Los 9 agentes, las ~24 tools, el Brain y el
 * circuito de aprobación estaban verificados por lectura del código y por un
 * harness de ruteo que no llama al modelo — por eso ALT-02 (aceptar una
 * recomendación de clasificación falla siempre) sobrevivió a la primera auditoría.
 * Este script es la primera prueba real, sobre UN doctor, no sobre los 7.034.
 *
 * QUÉ CORRE Y CUÁNTO CUESTA. `analyzeDoctor` hace como máximo DOS corridas de
 * modelo: el agente primario, y uno de apoyo solo si es `doctor_success` o
 * `clinical_education`. Cada corrida está acotada por dentro a 8 iteraciones de
 * tools (tope duro de 11 requests). El costo real sale de `agent_runs.cost_usd`,
 * que calcula `lib/ai/cost.ts` con los tokens que devolvió la API — no es un
 * estimado.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { analyzeDoctor } from "@/lib/ai/orchestrator";
import { createAiServiceClient } from "@/lib/ai/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtUsd(n: number | null): string {
  return n == null ? "—" : `USD ${n.toFixed(5)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const conJson = args.includes("--json");
  const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!query) {
    console.error('Uso: npx tsx scripts/ai-correr-doctor.ts "nombre o uuid" [--json]');
    process.exit(1);
  }

  // Se falla acá y no adentro del runner: el error del SDK sin clave es opaco.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "✗ ANTHROPIC_API_KEY vacía en .env.local — este script SÍ llama al modelo.\n" +
        "  Para ver el contexto sin gastar tokens: scripts/ai-dryrun-doctor.ts"
    );
    process.exit(1);
  }

  const db = createAiServiceClient();
  let id = query;
  let nombre = query;

  if (!UUID.test(query)) {
    const { data, error } = await db
      .from("doctors")
      .select("id, nombre, is_accredited, lifecycle_stage")
      .ilike("nombre", `%${query}%`)
      .order("is_accredited", { ascending: false })
      .limit(10);
    if (error) throw error;
    const filas = (data ?? []) as { id: string; nombre: string }[];
    if (filas.length === 0) {
      console.error(`Ningún doctor coincide con "${query}".`);
      process.exit(1);
    }
    if (filas.length > 1) {
      console.error(`${filas.length} coincidencias — precisá el nombre o pasá el uuid:`);
      for (const f of filas) console.error(`  ${f.id}  ${f.nombre}`);
      process.exit(1);
    }
    id = filas[0].id;
    nombre = filas[0].nombre;
  } else {
    const { data } = await db.from("doctors").select("nombre").eq("id", id).maybeSingle();
    nombre = (data as { nombre: string } | null)?.nombre ?? id;
  }

  // Marca de agua: solo se cuentan las corridas nacidas de ESTA invocación, así
  // el costo reportado no arrastra corridas anteriores del mismo doctor.
  const desde = new Date().toISOString();

  console.log(`\n  Corriendo la capa AI sobre: ${nombre}`);
  console.log(`  doctor_id: ${id}`);
  console.log(`  ESTO GASTA TOKENS. Máximo 2 corridas de modelo.\n`);

  const t0 = Date.now();
  const assessment = await analyzeDoctor(id, { requestedBy: null, trigger: "manual" });
  const segundos = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`  ─ Ruteo ─────────────────────────────────────────────`);
  console.log(`  primario : ${assessment.primary_agent}`);
  console.log(`  apoyo    : ${assessment.supporting_agents.join(", ") || "—"}`);
  console.log(`  confianza de datos: ${assessment.data_quality.data_confidence}/100`);
  console.log(`\n  ─ Resumen ───────────────────────────────────────────`);
  console.log(`  ${assessment.ai_summary}`);
  console.log(`\n  ─ Recomendaciones (${assessment.recommendations.length}) ──────────────────`);

  for (const [i, r] of assessment.recommendations.entries()) {
    console.log(`\n  [${i + 1}] ${r.recommendation_type} · ${r.agent} · canal ${r.channel}`);
    console.log(`      objetivo  : ${r.objective}`);
    console.log(`      situación : ${r.situation}`);
    console.log(`      ACCIÓN    : ${r.recommended_action}`);
    console.log(`      resultado esperado: ${r.expected_outcome}`);
    console.log(`      ejecuta   : ${r.owner_role}  ·  cuello: ${r.bottleneck}`);
    if (r.recommended_date) console.log(`      fecha     : ${r.recommended_date}`);
    if (r.follow_up_condition) console.log(`      seguimiento: ${r.follow_up_condition}`);
    if (r.evidence?.length) {
      console.log(`      evidencia (datos, no inferencia):`);
      for (const e of r.evidence.slice(0, 5)) console.log(`        · ${e.field} = ${e.value}`);
    }
    if (r.why?.length) {
      console.log(`      razonamiento (inferencia):`);
      for (const w of r.why.slice(0, 4)) console.log(`        · ${w}`);
    }
  }

  // ---- costo real, desde el ledger de corridas ----
  const { data: runs } = await db
    .from("agent_runs")
    .select("agent, model_version, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at")
    .eq("doctor_id", id)
    .gte("created_at", desde)
    .order("created_at", { ascending: true });

  const filas = (runs ?? []) as {
    agent: string; model_version: string | null;
    input_tokens: number | null; output_tokens: number | null;
    cache_read_tokens: number | null; cache_write_tokens: number | null;
    cost_usd: number | null;
  }[];

  console.log(`\n  ─ Costo real (agent_runs) ───────────────────────────`);
  let total = 0;
  for (const f of filas) {
    if (f.cost_usd == null && f.input_tokens == null) {
      console.log(`  ${f.agent.padEnd(24)} (corrida sintética, sin tokens)`);
      continue;
    }
    total += f.cost_usd ?? 0;
    console.log(
      `  ${f.agent.padEnd(24)} in ${String(f.input_tokens ?? 0).padStart(6)} · ` +
        `out ${String(f.output_tokens ?? 0).padStart(5)} · ` +
        `caché r/w ${f.cache_read_tokens ?? 0}/${f.cache_write_tokens ?? 0} · ${fmtUsd(f.cost_usd)}`
    );
  }
  console.log(`\n  TOTAL: ${fmtUsd(total)}  ·  ${segundos}s  ·  ${filas.length} corrida(s) registrada(s)`);
  console.log(`  Las recomendaciones quedaron en ai_recommendations con status 'propuesta':`);
  console.log(`  nadie ejecutó nada. Se aceptan o descartan desde la interfaz (HITL).`);

  if (conJson) {
    console.log(`\n  ─ Assessment crudo ──────────────────────────────────`);
    console.log(JSON.stringify(assessment, null, 2));
  }
}

main().catch((e) => {
  const err = e as Error;
  console.error(`\n✗ ${err.message}`);
  // Las tres primeras líneas del stack alcanzan para ubicar el archivo; el resto
  // es ruido del SDK y tapa el mensaje, que es lo que hay que leer.
  if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});

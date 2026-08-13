// Runner LLM de la capa multi-agente (docs/AI_ARCHITECTURE.md §5, §8, §9).
// - claude-opus-5 vía @anthropic-ai/sdk: thinking adaptativo por default (NO
//   mandar thinking/temperature/top_p — 400), chequear stop_reason==='refusal'
//   antes de leer content.
// - Tool loop manual: tools del registry (allowlist por agente) + tool `emit`
//   forzada al final; el output se valida con zod ANTES de persistir.
// - Persistencia: agent_runs + ai_recommendations vía cliente service-role
//   (SOLO tablas ai_*; nunca tablas CRM).

import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { AGENTS } from "@/lib/ai/agents";
import { getToolsForAgent } from "@/lib/ai/tools";
import { BRAIN_VERSION, getBrainSections } from "@/lib/ai/brain";
import { CACHE_TTL, estimateCostUsd } from "@/lib/ai/cost";
import { combine } from "@/lib/ai/confidence";
import { AI_EFFORT, AI_MODEL, aiConfigured, createAiServiceClient } from "@/lib/ai/db";
import {
  agentEmitSchema,
  directorBriefSchema,
  toStrictJsonSchema,
} from "@/lib/ai/schemas";
import type { DataCompleteness } from "@/lib/ai/completeness";
import type {
  AgentKey,
  AgentRecommendation,
  AgentRunTrigger,
  AiToolDef,
  DirectorBrief,
  DatasetCompleteness,
} from "@/lib/ai/types";

/** Trazabilidad del ruteo (agent_runs, migración 0022): por qué corrió ESTE
 *  agente y con qué evidencia. La arma el orchestrator. */
export interface RunRoutingMeta {
  primary_agent: string | null;
  supporting_agents: string[];
  routing_reason: string | null;
  routing_evidence: { field: string; value: string; source: string }[];
}

/** Confianza que soportan los datos del doctor (lib/ai/confidence.ts). Se guarda
 *  en agent_runs.data_quality y limita la confianza de cada recomendación. */
export interface RunDataQuality {
  score: number;
  caps: string[];
  interaction_data_quality?: string | null;
  cases_unclassified?: number | null;
  data_as_of?: string | null;
}

export interface RunAgentOptions {
  trigger: AgentRunTrigger;
  requestedBy: string | null;
  doctorId?: string | null;
  userMessage: string;
  extraSystem?: string;
  routing?: RunRoutingMeta;
  dataQuality?: RunDataQuality;
  /** Cuello de botella que calculó el ruteo — se guarda en la corrida para poder
   *  agregarlo después ("¿dónde está trabada la máquina comercial?"). */
  bottleneck?: string | null;
  /** Qué disparó el recálculo. Sin esto no se puede saber si estamos
   *  re-analizando doctores que no cambiaron (§57). */
  triggerReason?: string | null;
}

const MAX_TOKENS = 16_000;
const MAX_TOOL_ITERATIONS = 8;
// margen para reintentos de emit inválido después del cap
const HARD_REQUEST_LIMIT = MAX_TOOL_ITERATIONS + 3;

interface ToolCallLog {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  rows: number | null;
}

interface LlmRunOutcome {
  emitted: unknown; // objeto validado por zod (o null si no emitió)
  runId: string;
  status: "ok" | "error" | "refusal";
  errorText: string | null;
  /** Completitud real de los datos que vio el modelo (ver DatasetCompleteness). */
  dataset: DatasetCompleteness;
}

/**
 * Junta el `meta` que devuelve cada tool. La verdad sobre si un número está
 * completo no puede depender de que el modelo respete una instrucción: se mide
 * acá, del lado del servidor, con lo que las tools realmente devolvieron.
 */
function collectCompleteness(
  acc: { sources: Set<string>; limitations: Set<string>; tools: number },
  toolName: string,
  data: unknown
): void {
  acc.tools++;
  const meta = (data as { meta?: DataCompleteness } | null)?.meta;
  if (!meta || typeof meta !== "object") {
    // Una tool sin meta no puede declararse completa.
    acc.limitations.add(`${toolName}: no declaró completitud`);
    return;
  }
  if (meta.data_source) acc.sources.add(meta.data_source);
  if (meta.complete === false) {
    for (const l of meta.limitations ?? []) acc.limitations.add(`${toolName}: ${l}`);
    if (!meta.limitations?.length) acc.limitations.add(`${toolName}: dataset incompleto`);
  }
}

function summarizeCompleteness(acc: {
  sources: Set<string>;
  limitations: Set<string>;
  tools: number;
}): DatasetCompleteness {
  return {
    complete: acc.tools > 0 && acc.limitations.size === 0,
    sources: [...acc.sources],
    limitations: [...acc.limitations],
    tools_used: acc.tools,
  };
}

function buildTools(
  defs: AiToolDef[],
  emitJsonSchema: Record<string, unknown>,
  emitDescription: string
): Anthropic.Messages.Tool[] {
  // Ninguna tool va en strict: los schemas tienen args opcionales (sin required
  // completo) que el modo strict rechaza. La validación real la hace zod dentro
  // de cada handler y, para emit, el safeParse con reintento.
  const tools: Anthropic.Messages.Tool[] = defs.map((d: AiToolDef) => ({
    name: d.name,
    description: d.description,
    input_schema: d.inputSchema as Anthropic.Messages.Tool.InputSchema,
  }));
  // emit tampoco va en strict: el schema tiene un objeto abierto (payload
  // profile_update) que el modo strict rechaza con 400 al compilar el schema.
  // La garantía la da el safeParse de zod + reintento con is_error más abajo.
  tools.push({
    name: "emit",
    description: emitDescription,
    input_schema: emitJsonSchema as Anthropic.Messages.Tool.InputSchema,
  });
  return tools;
}

// Los bloques de respuesta (ContentBlock) son aceptados por la API como
// contenido de assistant en el siguiente turno (incluye thinking/tool_use);
// el tipo Param difiere solo en campos opcionales.
function asParamContent(
  content: Anthropic.Messages.ContentBlock[]
): Anthropic.Messages.ContentBlockParam[] {
  return content as unknown as Anthropic.Messages.ContentBlockParam[];
}

/**
 * Corrida completa de un agente: system (brain cacheado + prompt del agente),
 * loop de tools, validación zod del emit, y persistencia de agent_runs.
 * Devuelve SIEMPRE un runId (la corrida se registra también en error/refusal).
 */
async function runLLM(
  agent: AgentKey,
  opts: RunAgentOptions,
  emitZodSchema: z.ZodType,
  emitDescription: string
): Promise<LlmRunOutcome> {
  if (!aiConfigured()) {
    throw new Error("Falta ANTHROPIC_API_KEY en .env.local");
  }

  const spec = AGENTS[agent];
  const anthropic = new Anthropic();
  const supabase = createAiServiceClient();

  const toolDefs: AiToolDef[] = getToolsForAgent(agent);
  const toolsByName = new Map<string, AiToolDef>(
    toolDefs.map((d) => [d.name, d])
  );
  const tools = buildTools(toolDefs, toStrictJsonSchema(emitZodSchema), emitDescription);

  // Prompt caching. El orden de render de la API es tools → system → messages, y
  // un punto de caché cachea TODO lo que va antes. Van dos, de más estable a menos:
  //
  //   1. Brain (14.6k tokens) → cachea tools + brain.
  //   2. Prompt del agente (9.1k) → cachea tools + brain + prompt.
  //
  // El punto 2 faltaba, y era caro: el prompt del agente es lo más grande después
  // del Brain —más que las 14 tools juntas— y se reenviaba a precio pleno en CADA
  // iteración del bucle de tools. Medido sobre una corrida real: 9.080 tokens × 5
  // iteraciones = 45.400 tokens al precio de entrada, por doctor.
  //
  // `extraSystem` va en un tercer bloque SIN cachear, y esa es la razón de partirlo
  // en tres: si fuera parte del bloque 2, un valor variable cambiaría el prefijo y
  // le haría perder el caché al prompt del agente, que hoy es idéntico entre
  // corridas y entre doctores. Lo variable siempre va después del último punto.
  // TTL de 1 hora y no el de 5 minutos por defecto. El prefijo (Brain + prompt del
  // agente) es idéntico entre doctores, así que lo que decide el costo no es cuánto
  // dura una corrida sino cuánto tarda en llegar la siguiente.
  //
  // Escribir el caché sale 2× con TTL de 1h contra 1,25× con el de 5 min, así que
  // el punto de equilibrio son DOS corridas por ventana: con una sola por hora esto
  // sale ~0,06 más caro. Con dos o más, gana — y el uso real es trabajar la lista
  // de /hoy de corrido, no un doctor por hora. Medido: la escritura son 0,19 de los
  // 0,42 que cuesta un análisis, y con el TTL largo se paga una vez para todos los
  // doctores de esa hora en lugar de una vez por doctor.
  // El TTL sale de lib/ai/cost.ts, que es donde vive el multiplicador de escritura
  // que depende de él. Si se eligiera acá, cambiarlo dejaría el costo reportado por
  // debajo del real sin que nadie lo note.
  const CACHE: Anthropic.Messages.CacheControlEphemeral = {
    type: "ephemeral",
    ttl: CACHE_TTL,
  };

  const system: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: getBrainSections(spec.brainSections),
      cache_control: CACHE,
    },
    {
      type: "text",
      text: spec.systemPrompt,
      cache_control: CACHE,
    },
    ...(opts.extraSystem
      ? [{ type: "text" as const, text: opts.extraSystem }]
      : []),
  ];

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: opts.userMessage },
  ];

  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const toolsCalled: ToolCallLog[] = [];
  const datasetMetas = {
    sources: new Set<string>(),
    limitations: new Set<string>(),
    tools: 0,
  };

  let emitted: unknown = null;
  let status: "ok" | "error" | "refusal" = "ok";
  let errorText: string | null = null;

  try {
    let iterations = 0;
    let forceEmit = false;
    let requests = 0;

    while (requests < HARD_REQUEST_LIMIT) {
      requests++;
      const response = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: MAX_TOKENS,
        // `effort` va DENTRO de output_config, no arriba. Sin AI_EFFORT esto
        // manda "high", que es el default de la API: no cambia nada.
        output_config: { effort: AI_EFFORT },
        system,
        tools,
        messages,
        ...(forceEmit
          ? { tool_choice: { type: "tool" as const, name: "emit" } }
          : {}),
      });
      // input_tokens NO incluye lo servido por cache: sumarlo aparte o el
      // costo reportado en agent_runs baja justo cuando el cache funciona.
      cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
      inputTokens +=
        response.usage.input_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0);
      outputTokens += response.usage.output_tokens;

      // SIEMPRE antes de leer content
      if (response.stop_reason === "refusal") {
        status = "refusal";
        errorText = "El modelo rechazó la solicitud (stop_reason=refusal)";
        break;
      }

      messages.push({ role: "assistant", content: asParamContent(response.content) });
      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
      );

      // Un turno truncado (stop_reason='max_tokens') puede traer tool_use
      // completos: el protocolo exige responderlos con tool_result igual, así
      // que la decisión es por la presencia de bloques, no por stop_reason.
      if (toolUses.length === 0) {
        messages.push({
          role: "user",
          content: "Emite ahora tu resultado final llamando la tool `emit`.",
        });
        forceEmit = true;
        continue;
      }
      // Se truncó: cerrar en el próximo request en vez de seguir explorando.
      if (response.stop_reason === "max_tokens") forceEmit = true;

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const args = (tu.input ?? {}) as Record<string, unknown>;

        if (tu.name === "emit") {
          const parsed = emitZodSchema.safeParse(tu.input);
          if (parsed.success) {
            emitted = parsed.data;
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: "Resultado recibido.",
            });
          } else {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `El resultado no cumple el schema. Corrige y vuelve a llamar emit. Errores: ${JSON.stringify(parsed.error.issues)}`,
              is_error: true,
            });
          }
          continue;
        }

        const def = toolsByName.get(tu.name);
        const t0 = Date.now();
        if (!def) {
          toolsCalled.push({ name: tu.name, args, ms: Date.now() - t0, rows: null });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Tool desconocida: ${tu.name}`,
            is_error: true,
          });
          continue;
        }
        try {
          const res = await def.handler(args);
          toolsCalled.push({ name: tu.name, args, ms: Date.now() - t0, rows: res.rows });
          collectCompleteness(datasetMetas, tu.name, res.data);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(res.data),
          });
        } catch (e) {
          toolsCalled.push({ name: tu.name, args, ms: Date.now() - t0, rows: null });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Error ejecutando la tool: ${e instanceof Error ? e.message : String(e)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: results });

      if (emitted !== null) break;

      iterations++;
      if (iterations >= MAX_TOOL_ITERATIONS) forceEmit = true;
    }

    if (emitted === null && status === "ok") {
      status = "error";
      errorText =
        "El agente no emitió un resultado estructurado válido dentro del límite de iteraciones";
    }
  } catch (e) {
    status = "error";
    errorText = e instanceof Error ? e.message : String(e);
  }

  // Persistir la corrida SIEMPRE (ok | error | refusal) — observabilidad.
  const { data: runRow, error: runInsertError } = await supabase
    .from("agent_runs")
    .insert({
      agent,
      doctor_id: opts.doctorId ?? null,
      trigger: opts.trigger,
      requested_by: opts.requestedBy,
      model_version: AI_MODEL,
      brain_version: BRAIN_VERSION,
      status,
      error: errorText,
      latency_ms: Date.now() - started,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      cost_usd: estimateCostUsd({
        model: AI_MODEL,
        input: inputTokens - cacheReadTokens - cacheWriteTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        output: outputTokens,
      }),
      bottleneck: opts.bottleneck ?? null,
      trigger_reason: opts.triggerReason ?? null,
      tools_called: toolsCalled,
      recommendation_ids: [],
      result: (emitted as Record<string, unknown> | null) ?? null,
      // Trazabilidad del ruteo y de la calidad de datos (0022)
      primary_agent: opts.routing?.primary_agent ?? null,
      supporting_agents: opts.routing?.supporting_agents ?? [],
      routing_reason: opts.routing?.routing_reason ?? null,
      routing_evidence: opts.routing?.routing_evidence ?? [],
      data_quality: opts.dataQuality
        ? {
            data_confidence: opts.dataQuality.score,
            caps: opts.dataQuality.caps,
            interaction_data_quality: opts.dataQuality.interaction_data_quality ?? null,
            cases_unclassified: opts.dataQuality.cases_unclassified ?? null,
            data_as_of: opts.dataQuality.data_as_of ?? null,
          }
        : null,
    })
    .select("id")
    .single();

  if (runInsertError || !runRow) {
    throw new Error(
      `No se pudo registrar la corrida del agente: ${runInsertError?.message ?? "sin fila"}`
    );
  }

  return {
    emitted,
    runId: runRow.id as string,
    status,
    errorText,
    dataset: summarizeCompleteness(datasetMetas),
  };
}

/**
 * Expira propuestas superadas e inserta las nuevas recomendaciones (status
 * 'propuesta'), y actualiza agent_runs.recommendation_ids. Devuelve los ids.
 *
 * Confianza (0022): lo que emite el modelo es `reasoning_confidence`. La columna
 * `confidence` guarda la GLOBAL = min(razonamiento, datos), así que una certeza
 * alta sobre datos pobres nunca se persiste (ni se muestra) como confianza alta.
 * Sin contexto de doctor (director) no hay confianza de datos: se guarda null y
 * la global queda igual a la del modelo.
 */
async function persistRecommendations(
  runId: string,
  agent: AgentKey,
  recs: AgentRecommendation[],
  meta: {
    dataQuality?: RunDataQuality;
    supportingAgents?: string[];
    routingConfidence?: number | null;
  } = {}
): Promise<{ ids: string[]; persisted: AgentRecommendation[]; failures: string[] }> {
  const supabase = createAiServiceClient();
  const ids: string[] = [];
  const persisted: AgentRecommendation[] = [];
  const failures: string[] = [];
  const supportingAgents = meta.supportingAgents ?? [];

  for (const rec of recs) {
    // dedupe estilo alerts: una sola 'propuesta' por (doctor, agente, tipo)
    let expire = supabase
      .from("ai_recommendations")
      .update({ status: "expirada", resolved_at: new Date().toISOString() })
      .eq("agent", agent)
      .eq("recommendation_type", rec.recommendation_type)
      .eq("status", "propuesta");
    expire = rec.doctor_id
      ? expire.eq("doctor_id", rec.doctor_id)
      : expire.is("doctor_id", null);
    const { error: expireError } = await expire;
    if (expireError) {
      // Si no se pudo expirar, el índice único parcial va a rechazar el insert:
      // registrarlo en vez de dejar la recomendación desaparecer en silencio.
      failures.push(`${rec.recommendation_type}: no se pudo expirar la propuesta previa (${expireError.message})`);
      continue;
    }

    const breakdown = meta.dataQuality ? combine(rec.confidence, meta.dataQuality) : null;
    const { data, error } = await supabase
      .from("ai_recommendations")
      .insert({
        doctor_id: rec.doctor_id,
        agent,
        run_id: runId,
        brain_version: BRAIN_VERSION,
        model_version: AI_MODEL,
        recommendation_type: rec.recommendation_type,
        objective: rec.objective,
        situation: rec.situation,
        recommended_action: rec.recommended_action,
        channel: rec.channel,
        recommended_date: rec.recommended_date,
        // Next Best Action (Fase 3)
        bottleneck: rec.bottleneck,
        owner_role: rec.owner_role,
        current_stage: rec.current_stage,
        expected_outcome: rec.expected_outcome,
        follow_up_condition: rec.follow_up_condition,
        routing_confidence: meta.routingConfidence ?? null,
        why: rec.why,
        evidence: rec.evidence,
        // GLOBAL = min(razonamiento, datos)
        confidence: breakdown ? breakdown.overall : rec.confidence,
        reasoning_confidence: rec.confidence,
        data_confidence: breakdown ? breakdown.data : null,
        supporting_agents: supportingAgents,
        commercial_priority: rec.commercial_priority,
        clinical_handoff: rec.clinical_handoff,
        handoff_agent: rec.handoff_agent,
        suggested_message: rec.suggested_message,
        requires_user_confirmation: true,
        payload: rec.payload,
        status: "propuesta",
      })
      .select("id")
      .single();
    if (error || !data) {
      failures.push(`${rec.recommendation_type}: ${error?.message ?? "insert sin fila"}`);
      continue;
    }
    ids.push(data.id as string);
    // La UI muestra la confianza que quedó guardada, no la que declaró el modelo.
    persisted.push(breakdown ? { ...rec, confidence: breakdown.overall } : rec);
  }

  // Una recomendación que no se guardó no existe para el flujo de aprobación:
  // se anota en la corrida y no se devuelve a la UI.
  await supabase
    .from("agent_runs")
    .update({
      recommendation_ids: ids,
      ...(failures.length > 0
        ? { error: `No se persistieron ${failures.length} recomendación(es): ${failures.join(" | ")}` }
        : {}),
    })
    .eq("id", runId);

  return { ids, persisted, failures };
}

function throwRunFailure(outcome: LlmRunOutcome): never {
  if (outcome.status === "refusal") {
    throw new Error(
      "El modelo rechazó el análisis por políticas de seguridad. Ajusta la consulta e intenta de nuevo."
    );
  }
  throw new Error(
    `Falló la corrida del agente: ${outcome.errorText ?? "error desconocido"}`
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Forzado server-side, sin importar lo que haya emitido el modelo (V1: HITL).
// doctorId manda sobre el doctor_id emitido: si el modelo se equivoca de id, la
// acción aprobada terminaría escribiendo sobre otro doctor.
function enforceRecommendationInvariants(
  recs: AgentRecommendation[],
  agent: AgentKey,
  doctorId?: string | null
): AgentRecommendation[] {
  return recs.map((r) => ({
    ...r,
    agent,
    requires_user_confirmation: true,
    doctor_id: doctorId
      ? doctorId
      : r.doctor_id && UUID_RE.test(r.doctor_id)
        ? r.doctor_id
        : null,
  }));
}

const EMIT_AGENT_DESCRIPTION =
  "Emite el resultado final estructurado del análisis (1 a 3 recomendaciones). Llámala UNA sola vez, al final, cuando ya tengas la conclusión. Después de emitir no sigas trabajando.";

const EMIT_DIRECTOR_DESCRIPTION =
  "Emite el brief final estructurado para el manager (answer + findings + recommendations + data_as_of). Llámala UNA sola vez, al final, con los números ya verificados vía tools.";

export async function runAgentLLM(
  agent: AgentKey,
  opts: RunAgentOptions
): Promise<{ recommendations: AgentRecommendation[]; runId: string; raw?: unknown }> {
  const outcome = await runLLM(agent, opts, agentEmitSchema, EMIT_AGENT_DESCRIPTION);
  if (outcome.status !== "ok" || outcome.emitted === null) throwRunFailure(outcome);

  // zod ya validó el shape; el tipo TS difiere solo en payload.fields (Record
  // validado en runtime vs Partial<DoctorAiProfileFields> nominal).
  const emitted = outcome.emitted as { recommendations: AgentRecommendation[] };
  const recommendations = enforceRecommendationInvariants(
    emitted.recommendations,
    agent,
    opts.doctorId ?? null
  );
  const { persisted } = await persistRecommendations(
    outcome.runId,
    agent,
    recommendations,
    {
      dataQuality: opts.dataQuality,
      supportingAgents: opts.routing?.supporting_agents,
    }
  );
  // Solo se devuelven las que quedaron guardadas: la UI opera sobre filas reales.
  return { recommendations: persisted, runId: outcome.runId, raw: outcome.emitted };
}

export async function runDirectorLLM(
  opts: RunAgentOptions
): Promise<{ brief: DirectorBrief; runId: string }> {
  const outcome = await runLLM(
    "commercial_director",
    opts,
    directorBriefSchema,
    EMIT_DIRECTOR_DESCRIPTION
  );
  if (outcome.status !== "ok" || outcome.emitted === null) throwRunFailure(outcome);

  const emitted = outcome.emitted as DirectorBrief;
  const recommendations = enforceRecommendationInvariants(
    emitted.recommendations,
    "commercial_director"
  );
  const { persisted } = await persistRecommendations(
    outcome.runId,
    "commercial_director",
    recommendations,
    {
      // El director no analiza un doctor: no hay confianza de datos por doctor
      // que aplicar. data_confidence queda null y la global = la del modelo.
      dataQuality: opts.dataQuality,
      supportingAgents: opts.routing?.supporting_agents,
    }
  );
  // `dataset` lo pone el SERVIDOR, no el modelo: es la suma de lo que
  // realmente devolvieron las tools. Si alguna vino capada, el brief queda
  // marcado incompleto aunque el modelo haya redactado un total redondo.
  return {
    brief: { ...emitted, recommendations: persisted, dataset: outcome.dataset },
    runId: outcome.runId,
  };
}

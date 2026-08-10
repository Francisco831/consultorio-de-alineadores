// Tools de LECTURA del registry AI.
//
// CORRECTITUD ANTES QUE INTELIGENCIA. PostgREST corta TODO select en 1.000 filas
// y no devuelve error: cualquier agregado calculado contando filas en JS puede
// mentir en silencio. Con 6.4k doctores / 1.017 casos / 4.257 actividades eso ya
// pasaba. El trabajo del Director Comercial es citarle números a un manager, así
// que un número mal es la peor falla posible del sistema.
//
// Reglas de este archivo:
//  1. Todo lo AGREGADO se calcula en Postgres (migración 0023, funciones ai_*) y
//     se trae SOLO el agregado. Nunca se bajan 6.000 filas para contarlas acá.
//  2. Toda tool devuelve { data, meta } con meta: DataCompleteness — cuántas
//     filas se consideraron, de dónde salieron y qué NO dice el número.
//  3. Una lista capada SIEMPRE declara complete:false, el tope y el total real.
//  4. Nada se infiere: lo que no se sabe viaja como null y se dice por qué.
//
// Los nombres de las tools NO cambian: el runner y los prompts dependen de ellos.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { toStrictJsonSchema } from "@/lib/ai/schemas";
import { buildDoctorContext, contextToPromptBlock } from "@/lib/ai/context";
import {
  cappedListLimitation,
  complete,
  fromRpc,
  incomplete,
  withMeta,
  type DataCompleteness,
} from "@/lib/ai/completeness";
import { monthStartMX, todayMX } from "@/lib/dates";
import { daysSince, formatEtapa } from "@/lib/format";
import type { AiToolDef, AiToolResult } from "@/lib/ai/types";

const MAX_ROWS = 50;
/** Ventana por fuente en la timeline (antes de mezclar y ordenar). */
const TIMELINE_SOURCE_WINDOW = 100;
/** Ventana de actividades que arma el Context Engine. */
const CONTEXT_ACTIVITY_WINDOW = 200;

const ACQ_STAGES = [
  "identificado",
  "contacto_intentado",
  "contactado",
  "calificado",
  "reunion_agendada",
  "reunion_realizada",
  "interes_acreditacion",
  "acreditacion_agendada",
  "acreditado",
  "no_interesado",
] as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type SB = Awaited<ReturnType<typeof createClient>>;

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.output<S>) => Promise<AiToolResult>;
}): AiToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: toStrictJsonSchema(def.schema),
    handler: async (args) => def.handler(def.schema.parse(args)),
  };
}

function clampLimit(n: number | null | undefined, max = MAX_ROWS): number {
  if (n == null || !Number.isFinite(n)) return max;
  return Math.max(1, Math.min(Math.floor(n), max));
}

function bail(message: string): never {
  throw new Error(message);
}

/**
 * Llama una función de agregación de 0023. Devuelve el jsonb crudo (incluye
 * rows_considered y advertencias, que `fromRpc` mueve a meta).
 */
async function callAggregate(
  supabase: SB,
  fn: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) bail(`Error calculando ${fn}: ${error.message}`);
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    bail(`${fn} no devolvió un agregado: la respuesta no es utilizable`);
  }
  return data as Record<string, unknown>;
}

/** Atajo: agregado en Postgres → { data, meta } listo para el runner. */
async function aggregateResult(
  fn: string,
  args: Record<string, unknown>,
  extraLimitations: string[] = []
): Promise<AiToolResult> {
  const supabase = await createClient();
  const raw = await callAggregate(supabase, fn, args);
  const { data, meta } = fromRpc(raw, `Postgres ${fn}()`, extraLimitations);
  return { data: withMeta(data, meta), rows: meta.rows_considered };
}

/** Resultado de una lista leída directo de una tabla, con su total real. */
function listResult<T>(
  rows: T[],
  total: number | null,
  source: string,
  what: string,
  extraLimitations: string[] = [],
  order?: string
): AiToolResult {
  const realTotal = total ?? rows.length;
  const lims = [
    ...cappedListLimitation(rows.length, realTotal, what, order),
    ...extraLimitations,
  ];
  const meta: DataCompleteness = lims.length
    ? incomplete(realTotal, source, lims)
    : complete(realTotal, source);
  return { data: withMeta({ total: realTotal, mostrados: rows.length, items: rows }, meta), rows: realTotal };
}

const limitArg = z
  .number()
  .int()
  .nullish()
  .describe("máximo de filas a devolver (tope 50)");

const doctorIdArg = z.string().describe("id (uuid) del doctor en el CRM");

const META_NOTE =
  "Devuelve { data, meta }. `meta` declara rows_considered, la fuente y las limitaciones: si meta.complete es false NO presentes el número como definitivo — di qué falta.";

// ---------------------------------------------------------------------------
// agregación (calculada en Postgres — commercial_director)
// ---------------------------------------------------------------------------

const getPipeline = defineTool({
  name: "getPipeline",
  description:
    "Pipeline de oportunidades abiertas con la tira de forecast del mes (objetivo, casos nuevos, casos pagados del ledger, pipeline ponderado, forecast y gap) y el detalle de cada oportunidad. El agregado lo calcula Postgres sobre TODAS las filas, no sobre una muestra. Usala cuando el manager pregunta por el pipeline, el forecast del mes o el estado de las oportunidades abiertas. " +
    META_NOTE,
  schema: z.strictObject({}),
  handler: async () =>
    aggregateResult("ai_pipeline_summary", {
      p_period: monthStartMX(),
      p_limit: MAX_ROWS,
    }),
});

const getForecast = defineTool({
  name: "getForecast",
  description:
    "Forecast del mes en curso sin el detalle de oportunidades: objetivo de casos pagados, casos nuevos ingresados, casos pagados del ledger, pipeline ponderado, gap y avance de acreditaciones. Usala para '¿cómo venimos contra el objetivo?'. OJO: el objetivo es de casos PAGADOS y el forecast se arma con casos NUEVOS — son métricas distintas y la respuesta lo aclara. " +
    META_NOTE,
  schema: z.strictObject({}),
  handler: async () => aggregateResult("ai_forecast", { p_period: monthStartMX() }),
});

const getGoals = defineTool({
  name: "getGoals",
  description:
    "Objetivos (goals) de un mes: metas de casos pagados, acreditaciones y cuotas por persona. Usala cuando necesitás saber qué objetivo tiene el país o cada comercial en un período (default: mes en curso). " +
    META_NOTE,
  schema: z.strictObject({
    period: z
      .string()
      .nullish()
      .describe("mes a consultar en formato YYYY-MM o YYYY-MM-01 (default: mes actual)"),
  }),
  handler: async ({ period }) => {
    const supabase = await createClient();
    let periodISO = period ?? monthStartMX();
    if (/^\d{4}-\d{2}$/.test(periodISO)) periodISO = `${periodISO}-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodISO))
      bail("period inválido: usar YYYY-MM o YYYY-MM-01");

    const [{ data: goalsRaw, error, count }, { data: profilesRaw }] = await Promise.all([
      supabase
        .from("goals")
        .select("metric, target, user_id", { count: "exact" })
        .eq("period", periodISO)
        .order("metric")
        .limit(MAX_ROWS),
      supabase.from("profiles").select("id, nombre"),
    ]);
    if (error) bail(`Error leyendo goals: ${error.message}`);
    const names = new Map(
      ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [p.id, p.nombre])
    );
    const goals = (goalsRaw ?? []) as {
      metric: string;
      target: number;
      user_id: string | null;
    }[];
    const items = goals.map((g) => ({
      metric: g.metric,
      target: g.target,
      ambito: g.user_id ? (names.get(g.user_id) ?? "persona desconocida") : "país",
    }));
    const lims = cappedListLimitation(items.length, count ?? items.length, `objetivos de ${periodISO}`);
    if (items.length === 0)
      lims.push(`no hay objetivos cargados para ${periodISO}: no hay contra qué medir el avance.`);
    const meta = lims.length
      ? incomplete(count ?? items.length, "tabla goals", lims)
      : complete(count ?? items.length, "tabla goals");
    return {
      data: withMeta({ period: periodISO, objetivos: items }, meta),
      rows: count ?? items.length,
    };
  },
});

const getSalesRepPerformance = defineTool({
  name: "getSalesRepPerformance",
  description:
    "Métricas por persona del equipo comercial: casos nuevos del mes de sus doctores, objetivo individual, oportunidades abiertas, actividades / significativas / visitas / KeepDays de los últimos 30 días y tareas vencidas. Incluye los totales de control y cuánto NO se le atribuye a nadie (casos sin owner, actividades sin autor). Usala para preguntas de desempeño del equipo o de un comercial puntual. " +
    META_NOTE,
  schema: z.strictObject({}),
  handler: async () =>
    aggregateResult("ai_rep_performance", { p_days: 30, p_period: monthStartMX() }),
});

const getDoctorSegments = defineTool({
  name: "getDoctorSegments",
  description:
    "Foto de toda la base de doctores segmentada: totales por universo (A no acreditado / B acreditado), por lifecycle, por priority_bucket, por categoría y por etapa de adquisición/activación. Enumera TODOS los valores posibles (incluidos los que dan cero) y cuenta aparte los sin dato, así la suma de cada corte da siempre el total. Usala para dimensionar segmentos antes de pedir listas puntuales. " +
    META_NOTE,
  schema: z.strictObject({}),
  handler: async () => aggregateResult("ai_doctor_segments", {}),
});

const getCasesByPeriod = defineTool({
  name: "getCasesByPeriod",
  description:
    "Casos NUEVOS (is_new_case, 1ª etapa — la regla del KPI) en un rango de fechas: total, desglose por mes, doctores distintos y top 15 doctores del período. Devuelve también los casos de TODAS las etapas del rango para que no confundas una métrica con la otra. Usala para tendencias de producción o comparar meses. " +
    META_NOTE,
  schema: z.strictObject({
    from: z.string().describe("fecha inicial YYYY-MM-DD (inclusive)"),
    to: z.string().nullish().describe("fecha final YYYY-MM-DD (inclusive, default hoy)"),
  }),
  handler: async ({ from, to }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) bail("from inválido: usar YYYY-MM-DD");
    const hasta = to ?? todayMX();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta)) bail("to inválido: usar YYYY-MM-DD");
    if (hasta < from) bail("el rango es inválido: 'to' es anterior a 'from'");
    return aggregateResult("ai_cases_by_period", { p_from: from, p_to: hasta });
  },
});

// ---------------------------------------------------------------------------
// segmentos de doctores (listas top-N con total real, calculadas en Postgres)
// ---------------------------------------------------------------------------

const getAtRiskDoctors = defineTool({
  name: "getAtRiskDoctors",
  description:
    "Doctores en riesgo (lifecycle en_riesgo o priority_bucket riesgo/critico), ordenados por prioridad, con sus alertas abiertas. Devuelve el total real de doctores en riesgo además de la lista capada. Usala para retención: detectar a quién se le está cayendo el ritmo ANTES de que se duerma. " +
    META_NOTE,
  schema: z.strictObject({ limit: limitArg }),
  handler: async ({ limit }) =>
    aggregateResult("ai_at_risk_doctors", { p_limit: clampLimit(limit) }),
});

const getDormantDoctors = defineTool({
  name: "getDormantDoctors",
  description:
    "Doctores dormidos o perdidos del universo B (acreditados que dejaron de mandar casos), con días sin caso nuevo y si siguen recuperables (≤365 días). Devuelve el total real y cuántos no tienen fecha de último caso (esos quedan en null, NO en 0). Usala para reactivación. " +
    META_NOTE,
  schema: z.strictObject({
    limit: limitArg,
    incluir_perdidos: z
      .boolean()
      .nullish()
      .describe("incluir lifecycle 'perdido' además de 'dormido' (default true)"),
  }),
  handler: async ({ limit, incluir_perdidos }) =>
    aggregateResult("ai_dormant_doctors", {
      p_limit: clampLimit(limit),
      p_include_lost: incluir_perdidos !== false,
    }),
});

const getAccreditedNotActivated = defineTool({
  name: "getAccreditedNotActivated",
  description:
    "Doctores acreditados que NUNCA mandaron un caso nuevo (new_case_count=0), del más antiguo al más reciente. Devuelve el total real, el total de acreditados y cuántos no tienen fecha de acreditación (sin ella no se puede calcular el día 75). Usala para activación. " +
    META_NOTE,
  schema: z.strictObject({ limit: limitArg }),
  handler: async ({ limit }) =>
    aggregateResult("ai_accredited_not_activated", { p_limit: clampLimit(limit) }),
});

const getProspects = defineTool({
  name: "getProspects",
  description:
    "Prospectos del universo A (doctores NO acreditados) ordenados por prioridad, con filtros por etapa de adquisición, ciudad, fuente e interés mínimo. Devuelve cuántos cumplen el filtro EN TOTAL además de la lista capada. Usala para adquisición. " +
    META_NOTE,
  schema: z.strictObject({
    stage: z.enum(ACQ_STAGES).nullish().describe("filtrar por etapa de adquisición"),
    city: z.string().nullish().describe("filtrar por ciudad (búsqueda parcial)"),
    source: z.string().nullish().describe("filtrar por fuente de atribución"),
    min_interest: z.number().nullish().describe("interest_level mínimo (1-5)"),
    limit: limitArg,
  }),
  handler: async ({ stage, city, source, min_interest, limit }) =>
    aggregateResult("ai_prospects", {
      p_stage: stage ?? null,
      p_limit: clampLimit(limit),
      p_city: city?.trim() || null,
      p_source: source?.trim() || null,
      p_min_interest:
        min_interest == null || !Number.isFinite(min_interest)
          ? null
          : Math.round(min_interest),
    }),
});

const getServiceIssues = defineTool({
  name: "getServiceIssues",
  description:
    "Problemas de servicio abiertos: alertas de caso_atrasado / aprobacion_pendiente / oportunidad_estancada y casos con video sin aprobar hace más de 7 días — global o para un doctor puntual. El corte de 7 días se aplica ANTES del tope, así que el total es el real. Usala SIEMPRE antes de proponer cualquier acción comercial: servicio y confianza van antes que growth. " +
    META_NOTE,
  schema: z.strictObject({
    doctor_id: z.string().nullish().describe("limitar a un doctor puntual (uuid)"),
  }),
  handler: async ({ doctor_id }) =>
    aggregateResult("ai_service_issues", {
      p_limit: MAX_ROWS,
      p_doctor_id: doctor_id ?? null,
    }),
});

// ---------------------------------------------------------------------------
// por doctor (listas acotadas: siempre con el total real al lado)
// ---------------------------------------------------------------------------

const getDoctor360 = defineTool({
  name: "getDoctor360",
  description:
    "Contexto completo del doctor (Doctor 360) como bloque compacto: universo, etapas, casos, ritmo, contacto significativo, scores, casos estancados, oportunidades, tareas, perfil AI y frescura de datos. Usala como PRIMERA lectura al analizar cualquier doctor puntual. " +
    META_NOTE,
  schema: z.strictObject({ doctor_id: doctorIdArg }),
  handler: async ({ doctor_id }) => {
    const supabase = await createClient();
    const [ctx, { count: actCount }, { count: unknownCases }] = await Promise.all([
      buildDoctorContext(doctor_id),
      supabase
        .from("activities")
        .select("id", { count: "exact", head: true })
        .eq("doctor_id", doctor_id)
        .eq("is_demo", false),
      supabase
        .from("cases")
        .select("id", { count: "exact", head: true })
        .eq("doctor_id", doctor_id)
        .eq("is_demo", false)
        .eq("case_subject_type", "UNKNOWN"),
    ]);

    const lims: string[] = [];
    if ((actCount ?? 0) > CONTEXT_ACTIVITY_WINDOW) {
      lims.push(
        `el contexto usa las últimas ${CONTEXT_ACTIVITY_WINDOW} actividades de ${actCount}: la historia más vieja no está.`
      );
    }
    if (ctx.last_meaningful_contact == null) {
      lims.push(
        "no hay ningún contacto significativo registrado para este doctor. Ausencia de registro NO es ausencia de contacto: no concluyas abandono."
      );
    }
    if ((unknownCases ?? 0) > 0) {
      lims.push(
        `${unknownCases} casos con case_subject_type=UNKNOWN: no se puede distinguir el caso propio del doctor de su primer caso de paciente.`
      );
    }
    if (ctx.stalled_cases.length >= 10) {
      lims.push("los casos estancados se muestran hasta 10; puede haber más.");
    }
    const staleDays = daysSince(ctx.data_as_of);
    if (staleDays != null && staleDays > 7) {
      lims.push(
        `los datos son un snapshot del ${ctx.data_as_of} (hace ${staleDays} días): degrada la confianza y dilo.`
      );
    }
    const meta = lims.length
      ? incomplete(actCount ?? 0, "Context Engine (buildDoctorContext)", lims)
      : complete(actCount ?? 0, "Context Engine (buildDoctorContext)");
    return { data: withMeta(contextToPromptBlock(ctx), meta), rows: actCount ?? null };
  },
});

const getDoctorTimeline = defineTool({
  name: "getDoctorTimeline",
  description:
    "Timeline unificada del doctor: actividades, hitos de casos (ingreso/aprobación/finalizado) y cambios auditados (etapas, owner, categoría), del más reciente al más viejo. Usala cuando necesitás la secuencia temporal exacta de lo que pasó. " +
    META_NOTE,
  schema: z.strictObject({ doctor_id: doctorIdArg, limit: limitArg }),
  handler: async ({ doctor_id, limit }) => {
    const supabase = await createClient();
    const n = clampLimit(limit);
    const [
      { data: actsRaw, error: e1, count: actsTotal },
      { data: casesRaw, error: e2, count: casesTotal },
      { data: auditRaw, error: e3, count: auditTotal },
    ] = await Promise.all([
      supabase
        .from("activities")
        .select("type, occurred_at, summary, outcome", { count: "exact" })
        .eq("doctor_id", doctor_id)
        .eq("is_demo", false)
        .order("occurred_at", { ascending: false })
        .limit(TIMELINE_SOURCE_WINDOW),
      supabase
        .from("cases")
        .select(
          "id_externo, noloco_case_id, etapa, fecha_ingreso, fecha_aprobacion, fecha_finalizado",
          { count: "exact" }
        )
        .eq("doctor_id", doctor_id)
        .eq("is_demo", false)
        .order("fecha_ingreso", { ascending: false })
        .limit(TIMELINE_SOURCE_WINDOW),
      supabase
        .from("audit_log")
        .select("field, old_value, new_value, created_at, source", { count: "exact" })
        .eq("entity_type", "doctor")
        .eq("entity_id", doctor_id)
        .order("created_at", { ascending: false })
        .limit(TIMELINE_SOURCE_WINDOW),
    ]);
    if (e1) bail(`Error leyendo actividades: ${e1.message}`);
    if (e2) bail(`Error leyendo casos: ${e2.message}`);
    if (e3) bail(`Error leyendo auditoría: ${e3.message}`);

    interface Event {
      fecha: string;
      tipo: string;
      detalle: string;
    }
    const events: Event[] = [];
    for (const a of (actsRaw ?? []) as {
      type: string;
      occurred_at: string;
      summary: string | null;
      outcome: string | null;
    }[]) {
      events.push({
        fecha: a.occurred_at,
        tipo: a.type,
        detalle: [a.summary, a.outcome].filter(Boolean).join(" — ") || a.type,
      });
    }
    for (const c of (casesRaw ?? []) as {
      id_externo: string | null;
      noloco_case_id: string;
      etapa: string | null;
      fecha_ingreso: string;
      fecha_aprobacion: string | null;
      fecha_finalizado: string | null;
    }[]) {
      const label = c.id_externo ?? c.noloco_case_id;
      events.push({
        fecha: c.fecha_ingreso,
        tipo: "caso",
        detalle: `Caso ${label} ingresado${c.etapa ? ` (${formatEtapa(c.etapa)})` : ""}`,
      });
      if (c.fecha_aprobacion)
        events.push({ fecha: c.fecha_aprobacion, tipo: "caso", detalle: `Caso ${label} aprobado` });
      if (c.fecha_finalizado)
        events.push({ fecha: c.fecha_finalizado, tipo: "caso", detalle: `Caso ${label} finalizado` });
    }
    for (const e of (auditRaw ?? []) as {
      field: string;
      old_value: string | null;
      new_value: string | null;
      created_at: string;
      source: string;
    }[]) {
      events.push({
        fecha: e.created_at,
        tipo: "cambio",
        detalle: `${e.field}: ${e.old_value ?? "—"} → ${e.new_value ?? "—"} (${e.source})`,
      });
    }
    events.sort((a, b) => Date.parse(b.fecha) - Date.parse(a.fecha));
    const top = events.slice(0, n).map((e) => ({ ...e, fecha: e.fecha.slice(0, 10) }));

    const lims: string[] = [];
    for (const [name, shown, total] of [
      ["actividades", (actsRaw ?? []).length, actsTotal ?? 0],
      ["casos", (casesRaw ?? []).length, casesTotal ?? 0],
      ["cambios auditados", (auditRaw ?? []).length, auditTotal ?? 0],
    ] as [string, number, number][]) {
      if (shown < total)
        lims.push(
          `la timeline se armó con ${shown} de ${total} ${name} (ventana de ${TIMELINE_SOURCE_WINDOW} por fuente, los más recientes).`
        );
    }
    if (top.length < events.length)
      lims.push(
        `se muestran ${top.length} de ${events.length} eventos construidos (los más recientes).`
      );
    const considered = (actsTotal ?? 0) + (casesTotal ?? 0) + (auditTotal ?? 0);
    const source = "activities + cases + audit_log del doctor";
    const meta = lims.length ? incomplete(considered, source, lims) : complete(considered, source);
    return { data: withMeta(top, meta), rows: top.length };
  },
});

const getDoctorCases = defineTool({
  name: "getDoctorCases",
  description:
    "Casos del doctor con sus fechas de etapa (ingreso, aprobación, video, aprobación de video, impresión, finalizado) y el sujeto del caso (PATIENT / DOCTOR_SELF / OTHER / UNKNOWN). UNKNOWN significa que nadie lo clasificó: NO asumas que es un caso de paciente. Usala para ver el detalle de producción de un doctor. " +
    META_NOTE,
  schema: z.strictObject({ doctor_id: doctorIdArg, limit: limitArg }),
  handler: async ({ doctor_id, limit }) => {
    const supabase = await createClient();
    const n = clampLimit(limit);
    const { data, error, count } = await supabase
      .from("cases")
      .select(
        "id, id_externo, noloco_case_id, paciente, etapa, tipo_tratamiento, tipo_caso, is_new_case, case_subject_type, case_subject_source, fecha_ingreso, fecha_aprobacion, fecha_video, fecha_aprobacion_video, fecha_impresion, fecha_finalizado",
        { count: "exact" }
      )
      .eq("doctor_id", doctor_id)
      .eq("is_demo", false)
      .order("fecha_ingreso", { ascending: false })
      .limit(n);
    if (error) bail(`Error leyendo casos: ${error.message}`);

    interface Row {
      id_externo: string | null;
      noloco_case_id: string;
      paciente: string | null;
      etapa: string | null;
      tipo_tratamiento: string | null;
      tipo_caso: string | null;
      is_new_case: boolean;
      case_subject_type: string;
      case_subject_source: string | null;
      fecha_ingreso: string;
      fecha_aprobacion: string | null;
      fecha_video: string | null;
      fecha_aprobacion_video: string | null;
      fecha_impresion: string | null;
      fecha_finalizado: string | null;
    }
    const rows = (data ?? []) as Row[];
    const d = (iso: string | null) => iso?.slice(0, 10) ?? null;
    const items = rows.map((c) => ({
      caso: c.id_externo ?? c.noloco_case_id,
      paciente: c.paciente,
      etapa: formatEtapa(c.etapa),
      tipo: c.tipo_caso ?? c.tipo_tratamiento,
      caso_nuevo: c.is_new_case,
      sujeto: c.case_subject_type,
      sujeto_origen: c.case_subject_source,
      ingreso: d(c.fecha_ingreso),
      aprobado: d(c.fecha_aprobacion),
      video: d(c.fecha_video),
      video_aprobado: d(c.fecha_aprobacion_video),
      impresion: d(c.fecha_impresion),
      finalizado: d(c.fecha_finalizado),
    }));
    const unknown = items.filter((i) => i.sujeto === "UNKNOWN").length;
    const extra = unknown
      ? [
          `${unknown} de los ${items.length} casos listados tienen sujeto UNKNOWN: no se puede afirmar cuál fue el caso propio del doctor ni cuál su primer caso de paciente.`,
        ]
      : [];
    return listResult(
      items,
      count,
      "tabla cases del doctor",
      "casos del doctor",
      extra,
      "más reciente primero"
    );
  },
});

const getDoctorOpportunities = defineTool({
  name: "getDoctorOpportunities",
  description:
    "Oportunidades (pacientes potenciales) del doctor con etapa, días en etapa, probabilidad, monto y el ciclo de viabilidad (solicitada/enviada/respondida y su resultado). Por default solo las abiertas. Usala para saber qué pacientes concretos están en juego. " +
    META_NOTE,
  schema: z.strictObject({
    doctor_id: doctorIdArg,
    incluir_cerradas: z.boolean().nullish().describe("incluir ganadas/perdidas (default false)"),
  }),
  handler: async ({ doctor_id, incluir_cerradas }) => {
    const supabase = await createClient();
    let q = supabase
      .from("opportunities")
      .select(
        "id, patient_name, stage, stage_entered_at, probability, amount_mxn, forecast_category, expected_close_date, lost_reason, viability_status, viability_result, viability_requested_at, viability_follow_up_date, created_at",
        { count: "exact" }
      )
      .eq("doctor_id", doctor_id)
      .eq("is_demo", false)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    if (!incluir_cerradas) q = q.not("stage", "in", "(ganada,perdida)");
    const { data, error, count } = await q;
    if (error) bail(`Error leyendo oportunidades: ${error.message}`);

    interface Row {
      id: string;
      patient_name: string | null;
      stage: string;
      stage_entered_at: string;
      probability: number | null;
      amount_mxn: number | null;
      forecast_category: string;
      expected_close_date: string | null;
      lost_reason: string | null;
      viability_status: string | null;
      viability_result: string | null;
      viability_requested_at: string | null;
      viability_follow_up_date: string | null;
    }
    const rows = (data ?? []) as Row[];
    const items = rows.map((o) => ({
      id: o.id,
      paciente: o.patient_name,
      etapa: o.stage,
      dias_en_etapa: daysSince(o.stage_entered_at),
      probabilidad: o.probability,
      monto_mxn: o.amount_mxn,
      forecast_category: o.forecast_category,
      cierre_esperado: o.expected_close_date,
      motivo_perdida: o.lost_reason,
      viabilidad_estado: o.viability_status,
      viabilidad_resultado: o.viability_result,
      viabilidad_solicitada: o.viability_requested_at?.slice(0, 10) ?? null,
      viabilidad_seguimiento: o.viability_follow_up_date,
    }));
    const extra = incluir_cerradas
      ? []
      : ["solo se listan oportunidades ABIERTAS; las ganadas/perdidas quedan afuera."];
    return listResult(
      items,
      count,
      "tabla opportunities del doctor",
      "oportunidades del doctor",
      extra,
      "más reciente primero"
    );
  },
});

const getDoctorTasks = defineTool({
  name: "getDoctorTasks",
  description:
    "Tareas pendientes del doctor. Por default SOLO las creadas por humanos (excluye el flood de tareas automáticas de prospecto_sin_seguimiento) y declara cuántas automáticas quedaron afuera. Usala para ver compromisos ya agendados antes de proponer otros. " +
    META_NOTE,
  schema: z.strictObject({
    doctor_id: doctorIdArg,
    incluir_automaticas: z
      .boolean()
      .nullish()
      .describe("incluir tareas generadas por automations (default false)"),
  }),
  handler: async ({ doctor_id, incluir_automaticas }) => {
    const supabase = await createClient();
    let q = supabase
      .from("tasks")
      .select("id, title, type, due_date, assigned_to, automation_rule_id, created_at", {
        count: "exact",
      })
      .eq("doctor_id", doctor_id)
      .eq("status", "pendiente")
      .eq("is_demo", false)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(MAX_ROWS);
    if (!incluir_automaticas) q = q.is("automation_rule_id", null);

    const [{ data, error, count }, { data: profilesRaw }, { count: autoCount }] =
      await Promise.all([
        q,
        supabase.from("profiles").select("id, nombre"),
        incluir_automaticas
          ? Promise.resolve({ count: 0 })
          : supabase
              .from("tasks")
              .select("id", { count: "exact", head: true })
              .eq("doctor_id", doctor_id)
              .eq("status", "pendiente")
              .eq("is_demo", false)
              .not("automation_rule_id", "is", null),
      ]);
    if (error) bail(`Error leyendo tareas: ${error.message}`);
    const names = new Map(
      ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [p.id, p.nombre])
    );

    interface Row {
      id: string;
      title: string;
      type: string;
      due_date: string | null;
      assigned_to: string | null;
      automation_rule_id: string | null;
      created_at: string;
    }
    const today = todayMX();
    const rows = (data ?? []) as Row[];
    const items = rows.map((t) => ({
      id: t.id,
      titulo: t.title,
      tipo: t.type,
      vence: t.due_date,
      vencida: t.due_date != null && t.due_date < today,
      asignada_a: t.assigned_to ? (names.get(t.assigned_to) ?? null) : null,
      automatica: t.automation_rule_id != null,
      creada: t.created_at.slice(0, 10),
    }));
    const extra = (autoCount ?? 0) > 0
      ? [`${autoCount} tareas automáticas pendientes quedaron excluidas (ruido de automations).`]
      : [];
    return listResult(
      items,
      count,
      "tabla tasks del doctor",
      "tareas pendientes del doctor",
      extra,
      "por vencimiento"
    );
  },
});

const getAccreditationHistory = defineTool({
  name: "getAccreditationHistory",
  description:
    "Journey de acreditación del doctor: fechas clave (primer contacto, primera reunión, acreditación agendada/concretada, primer caso pagado, días a primer caso) más el historial auditado de movimientos por las etapas de adquisición. Usala en acreditación para saber dónde está y cuánto tardó cada paso. " +
    META_NOTE,
  schema: z.strictObject({ doctor_id: doctorIdArg }),
  handler: async ({ doctor_id }) => {
    const supabase = await createClient();
    const [{ data: docRaw, error }, { data: auditRaw, count }] = await Promise.all([
      supabase
        .from("doctors")
        .select(
          "nombre, is_accredited, acquisition_stage, activation_stage, first_contact_at, first_meeting_at, accreditation_scheduled_at, accredited_at, first_paid_case_at, days_to_first_case, lost_reason"
        )
        .eq("id", doctor_id)
        .single(),
      supabase
        .from("audit_log")
        .select("old_value, new_value, created_at, source", { count: "exact" })
        .eq("entity_type", "doctor")
        .eq("entity_id", doctor_id)
        .eq("field", "acquisition_stage")
        .order("created_at", { ascending: true })
        .limit(MAX_ROWS),
    ]);
    if (error || !docRaw) bail(`Doctor ${doctor_id} no encontrado`);

    const doc = docRaw as {
      nombre: string;
      is_accredited: boolean;
      acquisition_stage: string | null;
      activation_stage: string | null;
      first_contact_at: string | null;
      first_meeting_at: string | null;
      accreditation_scheduled_at: string | null;
      accredited_at: string | null;
      first_paid_case_at: string | null;
      days_to_first_case: number | null;
      lost_reason: string | null;
    };
    const d = (iso: string | null) => iso?.slice(0, 10) ?? null;
    const audit = (auditRaw ?? []) as {
      old_value: string | null;
      new_value: string | null;
      created_at: string;
      source: string;
    }[];

    const lims = cappedListLimitation(
      audit.length,
      count ?? audit.length,
      "movimientos de etapa auditados"
    );
    if (doc.is_accredited && doc.accredited_at == null)
      lims.push(
        "el doctor figura acreditado pero sin fecha de acreditación: no se puede calcular antigüedad ni el día 75."
      );
    if (audit.length === 0)
      lims.push(
        "no hay movimientos de etapa auditados: la etapa actual puede venir del import inicial y no de un avance registrado."
      );
    const source = "doctors + audit_log (acquisition_stage)";
    const meta = lims.length
      ? incomplete(count ?? audit.length, source, lims)
      : complete(count ?? audit.length, source);

    return {
      data: withMeta(
        {
          doctor: doc.nombre,
          acreditado: doc.is_accredited,
          etapa_adquisicion: doc.acquisition_stage,
          etapa_activacion: doc.activation_stage,
          primer_contacto: d(doc.first_contact_at),
          primera_reunion: d(doc.first_meeting_at),
          acreditacion_agendada: d(doc.accreditation_scheduled_at),
          acreditacion: d(doc.accredited_at),
          primer_caso_pagado: d(doc.first_paid_case_at),
          dias_a_primer_caso: doc.days_to_first_case,
          motivo_perdida: doc.lost_reason,
          historial_etapas: audit.map((e) => ({
            fecha: e.created_at.slice(0, 10),
            de: e.old_value,
            a: e.new_value,
            origen: e.source,
          })),
        },
        meta
      ),
      rows: count ?? audit.length,
    };
  },
});

const getTrainingHistory = defineTool({
  name: "getTrainingHistory",
  description:
    "Historial de capacitación del doctor: revisiones clínicas y KeepDays registrados como actividades, con fecha, resumen, resultado y calidad del contacto. Usala para saber qué formación ya recibió antes de proponer más educación clínica. " +
    META_NOTE,
  schema: z.strictObject({ doctor_id: doctorIdArg }),
  handler: async ({ doctor_id }) => {
    const supabase = await createClient();
    const { data, error, count } = await supabase
      .from("activities")
      .select("type, occurred_at, summary, outcome, engagement_quality, main_topic, next_action", {
        count: "exact",
      })
      .eq("doctor_id", doctor_id)
      .eq("is_demo", false)
      .in("type", ["revision_clinica", "keepday"])
      .order("occurred_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error) bail(`Error leyendo capacitaciones: ${error.message}`);
    const rows = (data ?? []) as {
      type: string;
      occurred_at: string;
      summary: string | null;
      outcome: string | null;
      engagement_quality: string;
      main_topic: string | null;
      next_action: string | null;
    }[];
    const items = rows.map((a) => ({
      fecha: a.occurred_at.slice(0, 10),
      tipo: a.type,
      resumen: a.summary,
      resultado: a.outcome,
      calidad: a.engagement_quality,
      tema: a.main_topic,
      proxima_accion: a.next_action,
    }));
    const extra =
      items.length === 0
        ? [
            "no hay revisiones clínicas ni KeepDays registrados. Ausencia de registro NO es ausencia de capacitación: el equipo puede no haberla cargado.",
          ]
        : [];
    return listResult(
      items,
      count,
      "activities tipo revision_clinica/keepday",
      "capacitaciones del doctor",
      extra,
      "más reciente primero"
    );
  },
});

const getClinicalInteractions = defineTool({
  name: "getClinicalInteractions",
  description:
    "Interacciones clínicas del doctor (revisiones clínicas registradas), con fecha, resumen, resultado, tema y próxima acción. Usala en educación clínica para entender inseguridades técnicas y qué quedó pendiente. " +
    META_NOTE,
  schema: z.strictObject({ doctor_id: doctorIdArg }),
  handler: async ({ doctor_id }) => {
    const supabase = await createClient();
    const { data, error, count } = await supabase
      .from("activities")
      .select("occurred_at, summary, outcome, engagement_quality, main_topic, next_action", {
        count: "exact",
      })
      .eq("doctor_id", doctor_id)
      .eq("is_demo", false)
      .eq("type", "revision_clinica")
      .order("occurred_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error) bail(`Error leyendo interacciones clínicas: ${error.message}`);
    const rows = (data ?? []) as {
      occurred_at: string;
      summary: string | null;
      outcome: string | null;
      engagement_quality: string;
      main_topic: string | null;
      next_action: string | null;
    }[];
    const items = rows.map((a) => ({
      fecha: a.occurred_at.slice(0, 10),
      resumen: a.summary,
      resultado: a.outcome,
      calidad: a.engagement_quality,
      tema: a.main_topic,
      proxima_accion: a.next_action,
    }));
    const extra =
      items.length === 0
        ? [
            "no hay revisiones clínicas registradas. Eso NO prueba que el doctor no haya tenido soporte clínico: puede no estar cargado.",
          ]
        : [];
    return listResult(
      items,
      count,
      "activities tipo revision_clinica",
      "interacciones clínicas del doctor",
      extra,
      "más reciente primero"
    );
  },
});

const searchDoctors = defineTool({
  name: "searchDoctors",
  description:
    "Busca doctores por nombre (búsqueda parcial) devolviendo id, universo, etapas, categoría y casos históricos, más el total de coincidencias. Usala cuando el usuario menciona un doctor por nombre y necesitás su id para las demás tools. " +
    META_NOTE,
  schema: z.strictObject({
    query: z.string().describe("nombre (o parte del nombre) del doctor"),
  }),
  handler: async ({ query }) => {
    const supabase = await createClient();
    const sanitized = query.replace(/[%_,()]/g, " ").trim();
    if (!sanitized) bail("query vacía");
    const { data, error, count } = await supabase
      .from("doctors")
      .select(
        "id, nombre, city, categoria, lifecycle_stage, is_accredited, acquisition_stage, activation_stage, new_case_count, last_new_case_at, priority_bucket",
        { count: "exact" }
      )
      .eq("is_demo", false)
      .ilike("nombre", `%${sanitized}%`)
      .order("new_case_count", { ascending: false })
      .limit(10);
    if (error) bail(`Error buscando doctores: ${error.message}`);

    interface Row {
      id: string;
      nombre: string;
      city: string | null;
      categoria: string;
      lifecycle_stage: string;
      is_accredited: boolean;
      acquisition_stage: string | null;
      activation_stage: string | null;
      new_case_count: number;
      last_new_case_at: string | null;
      priority_bucket: string | null;
    }
    const rows = (data ?? []) as Row[];
    const items = rows.map((d) => ({
      doctor_id: d.id,
      nombre: d.nombre,
      city: d.city,
      categoria: d.categoria,
      universo: d.is_accredited ? "B (acreditado)" : "A (no acreditado)",
      lifecycle: d.lifecycle_stage,
      etapa_adquisicion: d.acquisition_stage,
      etapa_activacion: d.activation_stage,
      casos_historicos: d.new_case_count,
      ultimo_caso: d.last_new_case_at?.slice(0, 10) ?? null,
      bucket: d.priority_bucket,
    }));
    const extra =
      items.length === 0
        ? [`ningún doctor coincide con "${sanitized}": no inventes uno, pide el nombre completo.`]
        : [];
    return listResult(
      items,
      count,
      "tabla doctors (búsqueda por nombre)",
      `coincidencias con "${sanitized}"`,
      extra,
      "más casos históricos primero"
    );
  },
});

export const READ_TOOLS: AiToolDef[] = [
  getPipeline,
  getForecast,
  getGoals,
  getSalesRepPerformance,
  getDoctorSegments,
  getCasesByPeriod,
  getAtRiskDoctors,
  getDormantDoctors,
  getAccreditedNotActivated,
  getProspects,
  getServiceIssues,
  getDoctor360,
  getDoctorTimeline,
  getDoctorCases,
  getDoctorOpportunities,
  getDoctorTasks,
  getAccreditationHistory,
  getTrainingHistory,
  getClinicalInteractions,
  searchDoctors,
];

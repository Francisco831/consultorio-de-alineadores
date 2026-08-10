// Harness de evaluación del ruteo (Módulo F) — SIN tokens, SIN modelo, SIN red.
//
// Corre el router determinístico sobre los 20 escenarios sintéticos y sobre un
// set de chequeos de regresión que codifican las reglas duras del negocio.
// Un fallo acá NO significa necesariamente un bug del harness: significa que el
// ruteo hace algo distinto de lo que el negocio espera. Ese es el punto.
//
// Convención de estado en runRegressionChecks(): un chequeo que todavía no se
// puede ejecutar porque depende de otro módulo devuelve passed=false con el
// detail prefijado con "PENDIENTE — ". El CLI lo muestra aparte y NO lo cuenta
// como fallo. Cualquier otro passed=false es un fallo real.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { AGENTS, AGENT_SPECS, buildSystemPrompt } from "@/lib/ai/agents";
import { CORE_SECTION_KEYS, getBrainSections } from "@/lib/ai/brain";
import { SECTIONS } from "@/lib/ai/brain/sections";
import { contextToPromptBlock } from "@/lib/ai/context";
import { routeDoctor } from "@/lib/ai/orchestrator";
import {
  SCENARIOS,
  makeAccredited,
  makeContext,
  makeServiceIssue,
  evalIsoAgo,
  type EvalDoctorContext,
  type ServiceSeverity,
} from "./scenarios";

// ---------------------------------------------------------------------------
// Lectura del resultado del router
// ---------------------------------------------------------------------------

/** Forma del RoutingResult que devolvió el router, sea el contrato nuevo
 *  (primary/supporting/routing_reason/routing_evidence) o el legacy
 *  (primary/involvements). Se observa, no se asume. */
export type RoutingShape = "contrato_nuevo" | "legacy_involvements" | "desconocida";

export interface ObservedRouting {
  primary: string | null;
  supporting: string[];
  routing_reason: string | null;
  routing_evidence: unknown[];
  shape: RoutingShape;
}

function agentOf(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "agent" in (value as object)) {
    const a = (value as { agent: unknown }).agent;
    return typeof a === "string" ? a : null;
  }
  return null;
}

function reasonOf(value: unknown): string | null {
  if (value && typeof value === "object" && "reason" in (value as object)) {
    const r = (value as { reason: unknown }).reason;
    return typeof r === "string" ? r : null;
  }
  return null;
}

function observeRouting(raw: unknown): ObservedRouting {
  const r = (raw ?? {}) as Record<string, unknown>;
  const primary = agentOf(r.primary);
  const routingReason =
    typeof r.routing_reason === "string" ? r.routing_reason : reasonOf(r.primary);
  const evidence = Array.isArray(r.routing_evidence) ? r.routing_evidence : [];

  if (Array.isArray(r.supporting)) {
    return {
      primary,
      supporting: r.supporting
        .map(agentOf)
        .filter((a): a is string => a !== null && a !== primary),
      routing_reason: routingReason,
      routing_evidence: evidence,
      shape: "contrato_nuevo",
    };
  }
  if (Array.isArray(r.involvements)) {
    return {
      primary,
      supporting: r.involvements
        .map(agentOf)
        .filter((a): a is string => a !== null && a !== primary),
      routing_reason: routingReason,
      routing_evidence: evidence,
      shape: "legacy_involvements",
    };
  }
  return {
    primary,
    supporting: [],
    routing_reason: routingReason,
    routing_evidence: evidence,
    shape: "desconocida",
  };
}

/** Ruta un contexto y observa el resultado, sin explotar si el router tira. */
function route(ctx: EvalDoctorContext): ObservedRouting | { error: string } {
  try {
    return observeRouting(routeDoctor(ctx));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function isError(r: ObservedRouting | { error: string }): r is { error: string } {
  return "error" in r;
}

/** Forma del RoutingResult observada corriendo el router una vez. Para que el
 *  CLI pueda declarar contra qué contrato se evaluó realmente. */
export function observedRoutingShape(): RoutingShape {
  const r = route(SCENARIOS[0].context);
  return isError(r) ? "desconocida" : r.shape;
}

// ---------------------------------------------------------------------------
// Evaluación de escenarios
// ---------------------------------------------------------------------------

export interface EvalResult {
  id: string;
  nombre: string;
  passed: boolean;
  expected_primary: string | null;
  actual_primary: string | null;
  expected_supporting: string[];
  actual_supporting: string[];
  failures: string[];
}

function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

export function runRoutingEval(): EvalResult[] {
  return SCENARIOS.map((sc): EvalResult => {
    const routed = route(sc.context);

    if (isError(routed)) {
      return {
        id: sc.id,
        nombre: sc.nombre,
        passed: false,
        expected_primary: sc.expected_primary,
        actual_primary: null,
        expected_supporting: sorted(sc.expected_supporting),
        actual_supporting: [],
        failures: [`routeDoctor lanzó una excepción: ${routed.error}`],
      };
    }

    const failures: string[] = [];

    if (routed.primary !== sc.expected_primary) {
      failures.push(
        `Primario esperado ${sc.expected_primary ?? "ninguno"} · el router devolvió ${routed.primary ?? "ninguno"}`
      );
    }

    const expected = sorted(sc.expected_supporting);
    const actual = sorted(routed.supporting);
    const faltan = expected.filter((a) => !actual.includes(a));
    const sobran = actual.filter((a) => !expected.includes(a));
    if (faltan.length > 0) {
      failures.push(`Faltan agentes de apoyo: ${faltan.join(", ")}`);
    }
    if (sobran.length > 0) {
      failures.push(`Agentes de apoyo de más: ${sobran.join(", ")}`);
    }

    // Un ruteo sin motivo no es auditable: la UI y el audit necesitan el porqué.
    if (routed.primary !== null && !routed.routing_reason) {
      failures.push("El ruteo no expone un motivo legible (routing_reason)");
    }

    return {
      id: sc.id,
      nombre: sc.nombre,
      passed: failures.length === 0,
      expected_primary: sc.expected_primary,
      actual_primary: routed.primary,
      expected_supporting: expected,
      actual_supporting: actual,
      failures,
    };
  });
}

// ---------------------------------------------------------------------------
// Chequeos de regresión (reglas duras del negocio)
// ---------------------------------------------------------------------------

export interface RegressionCheck {
  name: string;
  passed: boolean;
  detail: string;
}

const PENDIENTE = "PENDIENTE — ";

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function norm(s: string): string {
  return stripAccents(s).toLowerCase();
}

// --- helpers de contexto para los chequeos ---------------------------------

function activoConServicio(severity: ServiceSeverity): EvalDoctorContext {
  return makeAccredited({
    lifecycle: "activo",
    own_case_status: "COMPLETED",
    first_patient_case_status: "COMPLETED",
    second_patient_case_status: "COMPLETED",
    cases_total: 10,
    cases_30d: 2,
    cases_90d: 5,
    days_since_last_case: 15,
    open_cases: 3,
    service_issues: [
      makeServiceIssue({
        severity,
        confidence: severity === "LOW" || severity === "MEDIUM" ? "POSSIBLE" : "CONFIRMED",
        detail: `Problema de servicio de severidad ${severity}`,
      }),
    ],
  });
}

const NO_ACREDITADO_STAGES = [
  null,
  "identificado",
  "contacto_intentado",
  "contactado",
  "calificado",
  "reunion_agendada",
  "reunion_realizada",
  "interes_acreditacion",
  "acreditacion_agendada",
  "no_interesado",
] as const;

// --- lectura estática del código (para lo que no se puede probar sin DB) ----

function repoFile(...parts: string[]): string | null {
  try {
    return readFileSync(join(process.cwd(), ...parts), "utf8");
  } catch {
    return null;
  }
}

function readTsTree(relDir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const root = join(process.cwd(), relDir);
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(p);
      else if (e.endsWith(".ts")) {
        try {
          out.push({ file: p.slice(process.cwd().length + 1), text: readFileSync(p, "utf8") });
        } catch {
          /* ignorar */
        }
      }
    }
  };
  walk(root);
  return out;
}

// --- los chequeos ----------------------------------------------------------

export function runRegressionChecks(): RegressionCheck[] {
  const checks: RegressionCheck[] = [];

  // 1. Servicio grave secuestra el ruteo: SERVICE/TRUST antes que todo.
  {
    const malos: string[] = [];
    for (const sev of ["HIGH", "CRITICAL"] as const) {
      const r = route(activoConServicio(sev));
      if (isError(r)) malos.push(`${sev}: excepción ${r.error}`);
      else if (r.primary !== "doctor_success")
        malos.push(`${sev}: primario ${r.primary ?? "ninguno"}`);
    }
    checks.push({
      name: "Problema de servicio HIGH/CRITICAL ⇒ doctor_success primario",
      passed: malos.length === 0,
      detail:
        malos.length === 0
          ? "HIGH y CRITICAL rutean a doctor_success como primario"
          : `Esperado doctor_success primario · ${malos.join(" · ")}`,
    });
  }

  // 2. Una fricción menor NO puede secuestrar el ruteo, pero tampoco desaparecer.
  {
    const malos: string[] = [];
    for (const sev of ["LOW", "MEDIUM"] as const) {
      const r = route(activoConServicio(sev));
      if (isError(r)) {
        malos.push(`${sev}: excepción ${r.error}`);
        continue;
      }
      if (r.primary === "doctor_success")
        malos.push(`${sev}: doctor_success quedó de primario`);
      if (!r.supporting.includes("doctor_success"))
        malos.push(`${sev}: doctor_success tampoco aparece como apoyo`);
    }
    checks.push({
      name: "Problema de servicio LOW/MEDIUM ⇒ doctor_success de apoyo, nunca primario",
      passed: malos.length === 0,
      detail:
        malos.length === 0
          ? "LOW y MEDIUM dejan doctor_success como agente de apoyo"
          : malos.join(" · "),
    });
  }

  // 3. Una pregunta clínica concreta siempre involucra a clínica.
  {
    const ctx = makeAccredited({
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      cases_total: 5,
      days_since_last_case: 30,
      main_objection: "Pregunta si el caso de una paciente con mordida abierta es viable",
      open_opportunities: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          patient_name: "Paciente V.",
          stage: "viabilidad",
          days_in_stage: 4,
          probability: 25,
          amount_mxn: 30000,
        },
      ],
    });
    const r = route(ctx);
    const involucrados = isError(r) ? [] : [r.primary, ...r.supporting].filter(Boolean);
    const ok = involucrados.includes("clinical_education");
    checks.push({
      name: "Pregunta clínica específica ⇒ clinical_education involucrado",
      passed: ok,
      detail: isError(r)
        ? `Excepción: ${r.error}`
        : ok
          ? `Involucrados: ${involucrados.join(", ")}`
          : `clinical_education ausente · involucrados: ${involucrados.join(", ") || "ninguno"}`,
    });
  }

  // 4. Un no acreditado no puede tener objetivo de crecimiento: primero se acredita.
  {
    const malos: string[] = [];
    for (const stage of NO_ACREDITADO_STAGES) {
      const ctx = makeContext({
        is_accredited: false,
        acquisition_stage: stage,
        // datos que en universo B dispararían growth
        cases_total: 6,
        cases_30d: 2,
        cases_90d: 4,
        days_since_last_case: 12,
        potential_score: 90,
        lifecycle: "calificacion",
      });
      const r = route(ctx);
      if (isError(r)) {
        malos.push(`${stage ?? "sin etapa"}: excepción ${r.error}`);
        continue;
      }
      if (r.primary === "growth" || r.supporting.includes("growth"))
        malos.push(`${stage ?? "sin etapa"} ⇒ growth`);
    }
    checks.push({
      name: "No acreditado ⇒ nunca growth",
      passed: malos.length === 0,
      detail:
        malos.length === 0
          ? `Ninguna de las ${NO_ACREDITADO_STAGES.length} etapas de universo A rutea a growth`
          : `growth apareció en: ${malos.join(" · ")}`,
    });
  }

  // 5. Sin primer caso de paciente no hay nada que "retener": es activación.
  //    Se prueban las dos formas de "sin caso de paciente": NOT_STARTED (se sabe
  //    que no ocurrió) y UNKNOWN (no se sabe — el estado REAL de la base hoy,
  //    con los 1.017 casos sin clasificar). UNKNOWN nunca habilita retención:
  //    para retener hay que haber activado, y eso no está confirmado.
  {
    const malos: string[] = [];
    for (const lifecycle of ["en_riesgo", "dormido"] as const) {
      for (const hito of ["NOT_STARTED", "UNKNOWN"] as const) {
        const ctx = makeAccredited({
          lifecycle,
          own_case_status: hito === "UNKNOWN" ? "UNKNOWN" : "COMPLETED",
          first_patient_case_status: hito,
          second_patient_case_status: hito === "UNKNOWN" ? "UNKNOWN" : "NOT_STARTED",
          cases_unclassified: hito === "UNKNOWN" ? 3 : 0,
          cases_total: 0,
          days_since_last_case: null,
        });
        const r = route(ctx);
        if (isError(r)) {
          malos.push(`${lifecycle}/${hito}: excepción ${r.error}`);
          continue;
        }
        if (r.primary === "retention_reactivation")
          malos.push(`${lifecycle} + primer caso ${hito} ⇒ retention_reactivation primario`);
      }
    }
    checks.push({
      name: "Acreditado sin caso de paciente ⇒ retention nunca primario",
      passed: malos.length === 0,
      detail:
        malos.length === 0
          ? "en_riesgo y dormido sin primer caso de paciente (NOT_STARTED y UNKNOWN) NO rutean a retención como primario"
          : `${malos.join(" · ")} — no se puede retener a quien no está confirmado que activó; corresponde activación (retención como apoyo)`,
    });
  }

  // 6. El caso propio del doctor NO es su primer caso de paciente.
  {
    const problemas: string[] = [];
    const ctx = makeAccredited({
      lifecycle: "activado",
      own_case_status: "COMPLETED",
      first_patient_case_status: "NOT_STARTED",
      second_patient_case_status: "NOT_STARTED",
      cases_total: 0,
    });
    const r = route(ctx);
    if (isError(r)) problemas.push(`excepción al rutear: ${r.error}`);
    else if (r.primary !== "activation")
      problemas.push(
        `caso propio COMPLETED + paciente NOT_STARTED ⇒ primario ${r.primary ?? "ninguno"} (debería ser activation)`
      );

    // El Context Engine tiene que leer cases.case_subject_type (0022) para poder
    // separar el caso propio del de paciente. Si no lo lee, el hito se infiere.
    const ctxSrc = repoFile("lib", "ai", "context.ts");
    if (ctxSrc === null) problemas.push("no se pudo leer lib/ai/context.ts");
    else if (!ctxSrc.includes("case_subject_type"))
      problemas.push(
        "lib/ai/context.ts no lee cases.case_subject_type: el primer caso de paciente sigue infiriéndose del conteo de casos"
      );

    checks.push({
      name: "Caso propio ≠ primer caso de paciente",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? "El ruteo respeta el hito y el contexto se apoya en case_subject_type"
          : problemas.join(" · "),
    });
  }

  // 7. Datos de interacción POOR ⇒ prohibido afirmar inactividad.
  //    Se prueban las DOS variantes de POOR, porque la peligrosa es la segunda:
  //    a) sin ninguna actividad clasificada (el reloj es null), y
  //    b) con UNA actividad clasificada vieja entre decenas sin clasificar — ahí
  //       el bloque tiene una fecha y es donde se cuela "hace N días sin
  //       contacto" como si fuera un hecho.
  {
    const FRASE_PROHIBIDA = "sin contacto significativo hace";
    const variantes: { nombre: string; ctx: EvalDoctorContext }[] = [
      {
        nombre: "sin ninguna actividad clasificada",
        ctx: makeAccredited({
          lifecycle: "activo",
          own_case_status: "UNKNOWN",
          first_patient_case_status: "UNKNOWN",
          second_patient_case_status: "UNKNOWN",
          interaction_data_quality: "POOR",
          engagement_classified_count: 0,
          engagement_unknown_count: 41,
          last_meaningful_contact: null,
          days_since_meaningful_contact: null,
          cases_total: 3,
        }),
      },
      {
        nombre: "una sola actividad clasificada entre 40 sin clasificar",
        ctx: makeAccredited({
          lifecycle: "activo",
          own_case_status: "UNKNOWN",
          first_patient_case_status: "UNKNOWN",
          second_patient_case_status: "UNKNOWN",
          interaction_data_quality: "POOR",
          engagement_classified_count: 1,
          engagement_unknown_count: 40,
          last_meaningful_contact: evalIsoAgo(97),
          days_since_meaningful_contact: 97,
          cases_total: 3,
        }),
      },
    ];

    const problemas: string[] = [];
    let declara = 0;
    for (const v of variantes) {
      let block = "";
      try {
        block = contextToPromptBlock(v.ctx);
      } catch (e) {
        problemas.push(`${v.nombre}: excepción al renderizar — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const n = norm(block);
      if (n.includes(FRASE_PROHIBIDA)) {
        problemas.push(`${v.nombre}: el bloque contiene la frase prohibida "${FRASE_PROHIBIDA}"`);
      }
      // El bloque tiene que declarar la calidad del dato en alguna forma: si
      // muestra una antigüedad de contacto sin decir que el historial es POOR,
      // el modelo va a leer esa antigüedad como un hecho.
      const declaraCalidad =
        /POOR|calidad del? dato|calidad del historial|sin clasificar|AUSENCIA DE REGISTRO|no concluyas/i.test(
          block
        );
      if (declaraCalidad) declara += 1;
      else if (/contacto significativo[^\n]*hace \d+/i.test(stripAccents(block))) {
        problemas.push(
          `${v.nombre}: el bloque informa una antigüedad de contacto sin declarar que interaction_data_quality es POOR`
        );
      }
    }

    checks.push({
      name: "Datos de interacción POOR ⇒ ninguna afirmación de inactividad",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? `Las ${variantes.length} variantes POOR no afirman inactividad (${declara}/${variantes.length} declaran explícitamente la limitación del dato)`
          : problemas.join(" · "),
    });
  }

  // 8. UNKNOWN sigue UNKNOWN: nunca se convierte en hito cumplido.
  {
    const problemas: string[] = [];
    const ctx = makeAccredited({
      lifecycle: "activo",
      own_case_status: "UNKNOWN",
      first_patient_case_status: "UNKNOWN",
      second_patient_case_status: "UNKNOWN",
      cases_total: 4,
      cases_90d: 1,
      days_since_last_case: 40,
    });
    const r = route(ctx);
    if (isError(r)) problemas.push(`excepción al rutear: ${r.error}`);
    else if (r.primary === "growth")
      problemas.push(
        "con hitos UNKNOWN el primario fue growth: growth presupone un primer caso de paciente cumplido"
      );

    let block = "";
    try {
      block = contextToPromptBlock(ctx);
    } catch (e) {
      problemas.push(`excepción al renderizar el contexto: ${e instanceof Error ? e.message : String(e)}`);
    }
    const n = norm(block);
    for (const palabra of ["completed", "completado", "pagado", "cumplido"]) {
      if (n.includes(`primer caso de paciente: ${palabra}`)) {
        problemas.push(`el bloque de prompt declara el primer caso como "${palabra}" siendo UNKNOWN`);
      }
    }
    checks.push({
      name: "UNKNOWN sigue UNKNOWN (nunca se convierte en hito cumplido)",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? "Hitos UNKNOWN no producen ni ruteo de growth ni un hito cumplido en el prompt"
          : problemas.join(" · "),
    });
  }

  // 9. Sin oferta comercial vigente no hay descuento (depende del módulo de
  //    ofertas: commercial_offers se creó VACÍA a propósito en 0022).
  {
    // El propio harness menciona commercial_offers: no cuenta como lookup.
    const files = readTsTree("lib/ai").filter((f) => !f.file.includes("/eval/"));
    const consultan = files.filter((f) => f.text.includes("commercial_offers"));
    if (consultan.length === 0) {
      checks.push({
        name: "Sin oferta comercial vigente ⇒ ningún descuento inventado",
        passed: false,
        detail:
          `${PENDIENTE}ningún archivo de lib/ai/ consulta commercial_offers todavía, ` +
          "así que no hay camino de código que verificar. Cuando exista el lookup de ofertas, " +
          "este chequeo pasa a validar que el agente diga 'no hay condición comercial vigente configurada'.",
      });
    } else {
      // Con el lookup presente, el chequeo verificable sin modelo es que ningún
      // prompt/brain afirme un porcentaje de descuento como vigente.
      const sospechosos: string[] = [];
      for (const f of files) {
        for (const m of f.text.matchAll(/descuento[^.\n]{0,60}?(\d{1,3})\s*%/gi)) {
          const linea = m[0];
          if (/pendiente|sin resolver|abierto|no definid|no hay/i.test(linea)) continue;
          sospechosos.push(`${f.file}: "${linea.trim()}"`);
        }
      }
      checks.push({
        name: "Sin oferta comercial vigente ⇒ ningún descuento inventado",
        passed: sospechosos.length === 0,
        detail:
          sospechosos.length === 0
            ? `El descuento se resuelve contra commercial_offers (${consultan.map((f) => f.file).join(", ")}) y ningún prompt afirma un porcentaje vigente`
            : `Porcentajes de descuento afirmados en código: ${sospechosos.join(" · ")}`,
      });
    }
  }

  // 10. Agregación de dirección: el brief tiene que declarar si el dataset está
  //     completo (PostgREST corta en 1.000 filas sin avisar).
  {
    const faltantes: string[] = [];
    const schemas = repoFile("lib", "ai", "schemas.ts");
    const types = repoFile("lib", "ai", "types.ts");
    const read = repoFile("lib", "ai", "tools", "read.ts");
    // Acotado al DirectorBrief: `interaction_data_quality` del DoctorContext no
    // tiene nada que ver con la completitud de una agregación del director.
    const flagRe = /dataset_complete|datos_completos|dataset_quality|completeness|is_complete|rows_truncated|truncated/i;
    const bloque = (src: string | null, marcador: RegExp): string | null => {
      if (src === null) return null;
      const m = marcador.exec(src);
      if (!m) return null;
      return src.slice(m.index, m.index + 1200);
    };
    const briefType = bloque(types, /interface DirectorBrief\b/);
    const briefSchema = bloque(schemas, /directorBriefSchema\s*=/);

    if (briefType === null && briefSchema === null)
      faltantes.push("no se encontró la definición de DirectorBrief en types.ts/schemas.ts");
    else if (!flagRe.test(briefType ?? "") && !flagRe.test(briefSchema ?? ""))
      faltantes.push(
        "DirectorBrief no expone ningún flag de completitud del dataset (dataset_complete / rows_truncated): el manager no puede distinguir un total real de uno cortado"
      );

    // La agregación NO debe traer filas para contarlas: se calcula en Postgres
    // (RPC ai_*) y devuelve solo el agregado. Eso es más fuerte que paginar —
    // no hay muestra que truncar. Cada tool declara además su `meta`.
    if (read === null) faltantes.push("no se pudo leer lib/ai/tools/read.ts");
    else {
      // Las funciones se pasan por nombre a un helper (aggregateResult →
      // supabase.rpc), así que se verifica que exista la llamada rpc Y que se
      // nombren las funciones ai_* de la migración 0023.
      const nombraRpcs = /["']ai_[a-z_]+["']/.test(read);
      if (!read.includes(".rpc(") || !nombraRpcs)
        faltantes.push(
          "las tools de agregación no calculan en Postgres (no hay rpc a funciones ai_*): contar filas en JS expone al corte de 1.000 de PostgREST"
        );
      if (!read.includes("withMeta"))
        faltantes.push(
          "las tools no devuelven meta de completitud: el director no puede saber si un número está capado"
        );
    }

    // El flag del brief lo pone el runner con lo que devolvieron las tools, no
    // el modelo: verificamos que esa costura exista.
    const runner = repoFile("lib", "ai", "runner.ts");
    if (runner === null) faltantes.push("no se pudo leer lib/ai/runner.ts");
    else if (!runner.includes("summarizeCompleteness"))
      faltantes.push(
        "el runner no consolida la completitud de las tools: el flag del brief dependería de lo que diga el modelo"
      );

    checks.push({
      name: "Agregación de dirección ⇒ flag de dataset completo",
      passed: faltantes.length === 0,
      detail:
        faltantes.length === 0
          ? "El brief declara completitud (la calcula el runner con el meta de cada tool) y las agregaciones se resuelven en Postgres"
          : `${PENDIENTE}${faltantes.join(" · ")}`,
    });
  }

  // -------------------------------------------------------------------------
  // Chequeos de TONO Y COMPORTAMIENTO COMERCIAL (Commercial Brain V1)
  // -------------------------------------------------------------------------
  // No hay modelo en este harness, así que lo que se puede verificar sin gastar
  // un token es el TEXTO que va a condicionar al modelo (Brain + system prompts
  // + descripciones de tools) y el comportamiento del router. Es una cota
  // inferior honesta: prueba que no estamos PIDIENDO lo prohibido, no que el
  // modelo nunca lo va a producir. Eso último exige corridas con API key.

  // 11. Nada de voseo rioplatense en el texto que ve el modelo.
  {
    // Solo formas INEQUÍVOCAMENTE rioplatenses: el acento final es lo que separa
    // el voseo ("consultá") del imperativo mexicano de tú ("consulta"), que es
    // correcto y abunda en los prompts.
    // OJO con \b: en JS \w es [A-Za-z0-9_], así que una vocal acentuada cuenta
    // como límite de palabra y /\bmirá\b/ matchea DENTRO de "mirándolo". Los
    // lookarounds incluyen las acentuadas y la ñ para evitar ese falso positivo.
    const LETRA = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9_";
    const VOSEO = new RegExp(
      `(?<![${LETRA}])(vos|tenés|querés|podés|sabés|hacés|decís|venís|sos|mandame|decime|contame|fijate|acordate|dale|che|consultá|revisá|armá|decí|decilo|hablá|hacé|mirá|entendé|usá|pedí|escribí|proponé|aclará|citá|avisá|seguí|elegí|verificá|priorizá|explicá|devolvé|traé|buscá|dejá|mandá|tomá|contá|sumá|compará|evaluá|indicá|cargá|listá|ponelo|dejalo|llamala|llamalo|degradá|marcá|anotá|guardá|sacá|poné|andá)(?![${LETRA}])`
    );
    // Las líneas que DECLARAN la prohibición necesariamente nombran las palabras.
    const DECLARA_PROHIBICION = /prohibid|nada de voseo|no voseo|nunca voseo|voseo argentino|Prohibido el voseo/i;
    const sospechosos: string[] = [];
    for (const f of readTsTree("lib/ai").filter((x) => !x.file.includes("/eval/"))) {
      const lineas = f.text.split("\n");
      lineas.forEach((linea, i) => {
        // La prohibición puede declararse en la línea anterior y continuar
        // enumerando las palabras en esta.
        if (DECLARA_PROHIBICION.test(`${lineas[i - 1] ?? ""} ${linea}`)) return;
        // Solo interesa el texto que llega al modelo: prompts, secciones del
        // Brain y descripciones de tools. Los identificadores de código no.
        const m = VOSEO.exec(linea);
        if (m) sospechosos.push(`${f.file}:${i + 1} → "${m[0]}"`);
      });
    }
    checks.push({
      name: "Registro mexicano: cero voseo rioplatense en el texto que ve el modelo",
      passed: sospechosos.length === 0,
      detail:
        sospechosos.length === 0
          ? "Ni el Brain ni los system prompts ni las descripciones de tools usan voseo (un prompt en voseo contagia el borrador al doctor)"
          : `Voseo encontrado: ${sospechosos.slice(0, 8).join(" · ")}${sospechosos.length > 8 ? ` · +${sospechosos.length - 8} más` : ""}`,
    });
  }

  // 12. Las formulaciones prohibidas hacia el doctor solo aparecen marcadas como
  //     prohibidas — nunca como ejemplo de lo que hay que escribir.
  {
    const PROHIBIDAS = [
      "no ha enviado casos",
      "tiene que acreditarse",
      "necesitamos que mande",
      "esta atrasado",
      "debe hacer seguimiento",
      "todavia no cargo ningun caso",
      "hace tres meses que no manda casos",
      "hace mucho que no nos manda casos",
    ];
    const MARCADOR =
      /evitar|prohibid|nunca|jam[aá]s|nada de|no digas|no le digas|en vez de|antes que|mal:|insinuar|variante del reclamo|no se dice|dejarlo en falta/i;
    // Un ítem dentro de `acciones_prohibidas: [` ya está marcado por su ubicación:
    // el contrato entero de ese bloque es "esto no se hace".
    const ABRE_PROHIBIDAS = /acciones_prohibidas:\s*\[/;
    const CIERRA_BLOQUE = /^\s*\],?\s*$/;
    const malas: string[] = [];
    for (const f of readTsTree("lib/ai").filter((x) => !x.file.includes("/eval/"))) {
      const lineas = f.text.split("\n");
      let enProhibidas = false;
      lineas.forEach((linea, i) => {
        if (ABRE_PROHIBIDAS.test(linea)) enProhibidas = true;
        else if (enProhibidas && CIERRA_BLOQUE.test(linea)) enProhibidas = false;
        if (enProhibidas) return;
        const n = norm(linea);
        for (const frase of PROHIBIDAS) {
          if (!n.includes(frase)) continue;
          // El marcador puede estar en la misma línea o encabezar el bloque: las
          // frases prohibidas del Brain van como viñetas bajo un título
          // ("**Antes que estas** (prohibidas hacia el doctor):"), así que se
          // busca hacia atrás hasta la primera línea que no sea viñeta.
          let j = i - 1;
          while (j >= 0 && /^\s*[-*]\s/.test(lineas[j])) j -= 1;
          const contexto = [lineas[j] ?? "", lineas[i - 1] ?? "", linea].join(" ");
          if (!MARCADOR.test(contexto)) malas.push(`${f.file}:${i + 1} → "${frase}"`);
        }
      });
    }
    checks.push({
      name: "Formulaciones prohibidas hacia el doctor solo aparecen marcadas como prohibidas",
      passed: malas.length === 0,
      detail:
        malas.length === 0
          ? `Las ${PROHIBIDAS.length} formulaciones que hacen sentir al doctor evaluado o culpable aparecen únicamente como ejemplos de lo que NO se dice`
          : `Aparecen sin marcar como prohibidas: ${malas.join(" · ")}`,
    });
  }

  // 13. El núcleo del Brain llega a TODOS los agentes: es lo que impide que se
  //     comporten como agentes genéricos de SaaS B2B.
  {
    const problemas: string[] = [];
    const NUCLEO_ESPERADO = [
      "identity",
      "brand_values",
      "doctor_value",
      "commercial_philosophy",
      "mexico_culture",
      "communication",
      "guardrails",
      "pending_definitions",
    ];
    const faltan = NUCLEO_ESPERADO.filter((k) => !CORE_SECTION_KEYS.includes(k as never));
    if (faltan.length > 0) problemas.push(`el núcleo no incluye: ${faltan.join(", ")}`);

    for (const spec of Object.values(AGENTS)) {
      const texto = getBrainSections(spec.brainSections);
      if (!/¿qu[eé] necesita este doctor para avanzar con confianza\?/i.test(texto))
        problemas.push(`${spec.key}: no recibe la pregunta central`);
      if (!/NUNCA QUEMAR A UN DOCTOR PARA CERRAR UN MES/i.test(texto))
        problemas.push(`${spec.key}: no recibe el principio de valor de por vida`);
      if (!/de USTED por default/i.test(texto))
        problemas.push(`${spec.key}: no recibe la regla de trato mexicano`);
      if (!/no hay una condici[oó]n comercial vigente configurada/i.test(texto))
        problemas.push(`${spec.key}: no recibe la regla de cero números inventados`);
    }
    checks.push({
      name: "Los 9 agentes reciben el núcleo del Brain (identidad, doctor, cultura MX, guardrails)",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? `Los ${Object.keys(AGENTS).length} agentes reciben las ${CORE_SECTION_KEYS.length} secciones núcleo con la pregunta central, el principio de valor de por vida, el trato de usted y la regla de ofertas`
          : problemas.join(" · "),
    });
  }

  // 14. Ningún número comercial cotizable vive en el Brain (van en configuración).
  {
    const problemas: string[] = [];
    const conNumero = /\d/;
    for (const key of ["accreditation", "pricing"] as const) {
      const texto = SECTIONS[key];
      for (const linea of texto.split("\n")) {
        // La escalera de categorías nombra TRAMOS de casos acumulados (1-4, 5-19…):
        // eso es estructura, no una cotización. Lo que no puede haber es un
        // precio en MXN ni un porcentaje de descuento.
        if (/MXN|\$\s?\d|\d\s?%/.test(linea) && conNumero.test(linea))
          problemas.push(`${key}: "${linea.trim().slice(0, 90)}"`);
      }
    }
    if (!/getActiveCommercialOffers/.test(SECTIONS.accreditation))
      problemas.push("la sección de acreditación no remite a la configuración de ofertas");
    if (!/getActiveCommercialOffers/.test(SECTIONS.pricing))
      problemas.push("la sección de precio no remite a la configuración de ofertas");
    checks.push({
      name: "Cero precios y porcentajes cotizables en el Brain (viven en configuración)",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? "Acreditación y precio describen la estructura y remiten a getActiveCommercialOffers; ningún número cotizable está escrito en el texto"
          : problemas.join(" · "),
    });
  }

  // 15. Cadencia relativa al propio doctor: no inventar caídas ni taparlas.
  {
    const problemas: string[] = [];
    const conRitmo = (intervalo: number, sinCaso: number): EvalDoctorContext =>
      makeAccredited({
        lifecycle: "en_riesgo",
        own_case_status: "COMPLETED",
        first_patient_case_status: "COMPLETED",
        second_patient_case_status: "COMPLETED",
        cases_total: 10,
        cases_90d: 1,
        days_since_last_case: sinCaso,
        historical_case_frequency: {
          avg_interval_days: intervalo,
          expected_next_case_at: null,
          confidence: "personal",
        },
      });

    // Dentro de su patrón (45 días con intervalo de 90) ⇒ retención NO primaria.
    const lento = route(conRitmo(90, 45));
    if (isError(lento)) problemas.push(`ritmo lento: excepción ${lento.error}`);
    else {
      if (lento.primary === "retention_reactivation")
        problemas.push("45 días con intervalo propio de 90 ⇒ retención quedó primaria (alarma falsa)");
      if (!lento.supporting.includes("retention_reactivation"))
        problemas.push("45 días con intervalo propio de 90 ⇒ retención desapareció del análisis en vez de acompañar");
      if (!/dentro de su patr[oó]n|frecuencia hist[oó]rica/i.test(lento.routing_reason ?? ""))
        problemas.push("el motivo del ruteo no explica que el silencio cabe en su frecuencia propia");
    }

    // Fuera de su patrón (40 días con intervalo de 8) ⇒ retención primaria.
    const rapido = route(conRitmo(8, 40));
    if (isError(rapido)) problemas.push(`ritmo alto: excepción ${rapido.error}`);
    else if (rapido.primary !== "retention_reactivation")
      problemas.push(
        `40 días con intervalo propio de 8 ⇒ primario ${rapido.primary ?? "ninguno"} (debería ser retención)`
      );

    checks.push({
      name: "Cadencia relativa: 45 días no es caída para quien manda cada 90; 40 sí para quien manda cada 8",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? "La caída se mide contra la frecuencia histórica del propio doctor, no contra un umbral fijo"
          : problemas.join(" · "),
    });
  }

  // 16. "No contactar hoy" tiene que ser una salida posible del sistema.
  {
    const ctx = makeAccredited({
      lifecycle: "activo",
      own_case_status: "COMPLETED",
      first_patient_case_status: "COMPLETED",
      second_patient_case_status: "COMPLETED",
      cases_total: 9,
      cases_90d: 3,
      days_since_last_case: 14,
      interaction_data_quality: "GOOD",
      engagement_classified_count: 18,
      engagement_unknown_count: 0,
      last_meaningful_contact: evalIsoAgo(1),
      days_since_meaningful_contact: 1,
      historical_case_frequency: {
        avg_interval_days: 30,
        expected_next_case_at: null,
        confidence: "personal",
      },
    });
    const r = route(ctx);
    const ok =
      !isError(r) && /no contactar hoy|puede ser NO contactar/i.test(r.routing_reason ?? "");
    checks.push({
      name: "Contacto significativo reciente y sin urgencia ⇒ el sistema puede recomendar NO contactar",
      passed: ok,
      detail: isError(r)
        ? `Excepción: ${r.error}`
        : ok
          ? "Con un contacto significativo de ayer y nada urgente abierto, el ruteo deja explícito que esperar es una recomendación válida"
          : `El ruteo no contempla esperar: "${(r.routing_reason ?? "").slice(0, 160)}"`,
    });
  }

  // 17. El equipo clínico no está hardcodeado a una persona.
  {
    const problemas: string[] = [];
    const brainClinico = SECTIONS.clinical_owner + SECTIONS.clinical + SECTIONS.escalation;
    if (!/clinical_owner|clinical owner/i.test(brainClinico))
      problemas.push("el Brain no habla de clinical_owner: la derivación quedaría atada a una persona");
    if (!/no hardcodear|no supongas|equipo cl[ií]nico/i.test(brainClinico))
      problemas.push("el Brain no prevé que el clinical owner pueda no ser siempre la misma persona");
    const promptClinico = AGENTS.clinical_education.systemPrompt;
    if (!/clinical_owner/.test(promptClinico))
      problemas.push("el prompt de educación clínica no usa el clinical_owner del doctor");
    // Con prioridad clínica alta y sin clinical owner asignado, el ruteo lo dice.
    const sinOwner = route(
      makeAccredited({
        lifecycle: "en_activacion",
        clinical_owner: null,
        accreditation_date: null,
        days_since_accreditation: 40,
        own_case_status: "NOT_STARTED",
        first_patient_case_status: "NOT_STARTED",
        second_patient_case_status: "NOT_STARTED",
      })
    );
    if (isError(sinOwner)) problemas.push(`excepción al rutear sin clinical owner: ${sinOwner.error}`);
    else if (!sinOwner.supporting.includes("clinical_education") && sinOwner.primary !== "clinical_education")
      problemas.push("un recién acreditado sin primer caso no involucra al agente clínico (prioridad clínica nivel 2)");

    checks.push({
      name: "El equipo clínico se resuelve por clinical_owner, no por una persona fija",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? "Brain, prompt y ruteo usan el clinical owner del doctor y declaran cuándo no hay ninguno asignado"
          : problemas.join(" · "),
    });
  }

  // -------------------------------------------------------------------------
  // Chequeos de ESPECIALIZACIÓN (Fase 3)
  // -------------------------------------------------------------------------
  // El pedido fue textual: "no quiero nueve prompts con nombres diferentes
  // haciendo básicamente lo mismo". Esto lo verifica sobre el contrato, que es
  // de donde se genera el prompt.

  // 18. Los 9 declaran un contrato completo y no intercambiable.
  {
    const problemas: string[] = [];
    const specs = Object.values(AGENT_SPECS);
    if (specs.length !== 9) problemas.push(`hay ${specs.length} contratos, deberían ser 9`);

    for (const s of specs) {
      const faltantes: string[] = [];
      if (s.universo.length < 80) faltantes.push("universo");
      if (s.mision.length < 80) faltantes.push("misión");
      if (!s.kpi_primario) faltantes.push("kpi_primario");
      if (s.bottlenecks.length === 0) faltantes.push("bottlenecks");
      if (s.senales.length < 6) faltantes.push("señales (<6)");
      if (s.hipotesis.length < 3) faltantes.push("hipótesis (<3)");
      if (s.acciones_permitidas.length < 5) faltantes.push("acciones permitidas (<5)");
      if (s.acciones_prohibidas.length < 4) faltantes.push("acciones prohibidas (<4)");
      if (s.priorizacion.length < 3) faltantes.push("priorización (<3)");
      if (faltantes.length > 0) problemas.push(`${s.key}: ${faltantes.join(", ")}`);
    }

    // Ningún par comparte misión ni KPI primario: si dos son intercambiables,
    // son el mismo agente con dos nombres.
    const vistos = new Map<string, string>();
    for (const s of specs) {
      for (const [campo, valor] of [
        ["misión", s.mision],
        ["KPI primario", s.kpi_primario],
        ["universo", s.universo],
      ] as const) {
        const clave = `${campo}:${norm(valor).slice(0, 120)}`;
        const previo = vistos.get(clave);
        if (previo) problemas.push(`${s.key} y ${previo} comparten ${campo}`);
        else vistos.set(clave, s.key);
      }
    }

    checks.push({
      name: "Los 9 agentes son especialistas: contrato completo y no intercambiable",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? `Los 9 declaran universo, misión, KPI, cuellos de botella, señales, hipótesis, acciones permitidas y prohibidas, handoffs y priorización — sin misión, KPI ni universo repetidos`
          : problemas.join(" · "),
    });
  }

  // 19. El prompt se GENERA del contrato: no hay un segundo texto que se pueda
  //     desincronizar de lo que el sistema declara que el agente hace.
  {
    const problemas: string[] = [];
    const src = repoFile("lib", "ai", "agents", "index.ts");
    if (src === null) problemas.push("no se pudo leer lib/ai/agents/index.ts");
    else if (/systemPrompt:\s*`/.test(src))
      problemas.push(
        "hay al menos un systemPrompt escrito a mano en el archivo de agentes: el contrato deja de ser la única fuente"
      );

    for (const s of Object.values(AGENT_SPECS)) {
      const prompt = buildSystemPrompt(s);
      if (!prompt.includes(s.universo)) problemas.push(`${s.key}: el prompt no incluye su universo`);
      if (!prompt.includes(s.kpi_primario)) problemas.push(`${s.key}: el prompt no incluye su KPI`);
      if (!prompt.includes(s.acciones_prohibidas[0] ?? "—"))
        problemas.push(`${s.key}: el prompt no incluye sus prohibiciones`);
    }
    checks.push({
      name: "El system prompt se genera del contrato (una sola fuente)",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? "Los 9 prompts se componen con buildSystemPrompt a partir del contrato declarado; no hay texto suelto que se pueda desincronizar"
          : problemas.join(" · "),
    });
  }

  // 20. Las dos acciones "de todos" tienen una regla de desempate.
  //     Sin esto, sobre la base real (0% clasificada, 11 owners de 7.034) los
  //     nueve agentes emiten la misma recomendación y el sistema deja de ser
  //     especialista justo donde más importa.
  {
    const problemas: string[] = [];
    const comun = buildSystemPrompt(AGENT_SPECS.growth);
    if (!/SIN_DUENO/.test(comun) || !/DATOS_INSUFICIENTES/.test(comun))
      problemas.push("el bloque común no nombra los cuellos que gobiernan las acciones de sistema");
    if (!/no son de todos|no son tuyas/i.test(comun))
      problemas.push("el bloque común no dice que asignar dueño y clasificar datos no son de cualquiera");
    // Y el ruteo tiene que poder declarar esos cuellos.
    const sinDueno = route(
      makeAccredited({
        lifecycle: "activo",
        owner: null,
        own_case_status: "COMPLETED",
        first_patient_case_status: "COMPLETED",
        second_patient_case_status: "COMPLETED",
        cases_total: 8,
        cases_90d: 3,
        days_since_last_case: 20,
        potential_score: 40,
      })
    );
    if (isError(sinDueno)) problemas.push(`excepción al rutear sin dueño: ${sinDueno.error}`);

    checks.push({
      name: "Asignar dueño y clasificar datos las gobierna el cuello de botella, no los 9 agentes",
      passed: problemas.length === 0,
      detail:
        problemas.length === 0
          ? "El bloque común resuelve el empate por cuello de botella (SIN_DUENO / DATOS_INSUFICIENTES); el resto de los agentes lo declara como límite, no como recomendación"
          : problemas.join(" · "),
    });
  }

  return checks;
}

/** Un chequeo que todavía no se puede ejecutar (depende de otro módulo). */
export function isPending(check: RegressionCheck): boolean {
  return !check.passed && check.detail.startsWith(PENDIENTE);
}

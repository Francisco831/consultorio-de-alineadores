// Context Engine — arma el DoctorContext tipado que consumen todos los agentes.
// Reutiliza las queries del Doctor 360 (app/(app)/doctores/[id]) + derivados del
// diseño (docs/AI_ARCHITECTURE.md §4). NO manda la base entera al modelo:
// contextToPromptBlock renderiza un resumen compacto; el detalle se pide por tools.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAiReadClient } from "@/lib/ai/read-client";
import { todayMX } from "@/lib/dates";
import { daysSince } from "@/lib/format";
import { refOportunidad } from "@/lib/ai/pii";
import type { Case, Doctor, TaskType } from "@/lib/types";
import type {
  ActivitySummary,
  AiRecommendationRow,
  DoctorAiProfileRow,
  DoctorContext,
  InteractionDataQuality,
  MilestoneStatus,
  OpportunitySummary,
  PaidCaseSource,
  SecondCaseStatus,
  ServiceConfidence,
  ServiceIssue,
  ServiceSeverity,
  StalledCase,
  TaskSummary,
} from "@/lib/ai/types";

const DAY_MS = 86_400_000;

/** Alertas del motor determinístico que cuentan como problema de servicio. */
const SERVICE_RULE_KEYS = new Set([
  "caso_atrasado",
  "aprobacion_pendiente",
  "oportunidad_estancada",
]);

/** Días esperados por etapa de oportunidad — mismos defaults que la regla
 *  'oportunidad_estancada' de 0006 (la alerta dispara a 1,5x). */
const EXPECTED_OPP_STAGE_DAYS: Record<string, number> = {
  viabilidad: 7,
  paciente_potencial: 14,
  documentacion: 7,
  caso_ingresado: 7,
  planificacion: 7,
  presentada: 5,
  decision: 4,
  compromiso: 7,
};

/** Días esperados por la regla 'aprobacion_pendiente' (param days, default 7). */
const EXPECTED_VIDEO_APPROVAL_DAYS = 7;
/** Umbral genérico de etapa (fallback). */
const EXPECTED_STAGE_MOVE_DAYS = 10;
/** Días razonables para que el doctor complete la documentación del caso. */
const EXPECTED_DOCUMENTATION_DAYS = 10;
/** Días razonables para que ortodoncia publique el video tras la documentación. */
const EXPECTED_PLANNING_DAYS = 10;
/** Días razonables para imprimir tras la aprobación del doctor. */
const EXPECTED_PRINT_DAYS = 10;
/**
 * Más allá de esto, un caso parado casi seguro es un hueco de dato y no un
 * atraso vivo: `fecha_entrega` no se importa NUNCA (0 de 1.017) y solo 359
 * tienen `fecha_finalizado`, así que el CRM no puede saber que un caso terminó.
 */
const STALE_DATA_DAYS = 365;

// columnas de cases que existen en DB pero no en el tipo compartido lib/types
type CaseRow = Case & {
  fecha_edicion: string | null;
  fecha_movimientos: string | null;
  fecha_entrega: string | null;
  case_subject_type: "PATIENT" | "DOCTOR_SELF" | "OTHER" | "UNKNOWN";
  case_subject_source: string | null;
};

interface TaskRow {
  id: string;
  title: string;
  type: TaskType;
  due_date: string | null;
  automation_rule_id: string | null;
  created_at: string;
}

interface ActivityRow {
  type: string;
  occurred_at: string;
  summary: string | null;
  outcome: string | null;
  engagement_quality: "MEANINGFUL" | "LOW_TOUCH" | "UNKNOWN";
}

interface AlertRow {
  id: string;
  rule_key: string;
  opportunity_id: string | null;
  severity: string;
  status: string;
  title: string;
  reason: string | null;
  created_at: string;
  service_confidence: ServiceConfidence | null;
  trust_risk_score: number | null;
  impact_factors: unknown;
}

interface PaymentRow {
  paid_at: string;
  case_id: string | null;
}

interface OppRow {
  id: string;
  patient_name: string | null;
  stage: string;
  stage_entered_at: string;
  probability: number | null;
  amount_mxn: number | null;
}

interface WaRow {
  unanswered: boolean;
  activity_bucket: string | null;
}

interface ContactRow {
  nombre: string;
  phone: string | null;
  whatsapp: string | null;
  es_principal: boolean;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Días entre dos fechas (b - a). null si falta alguna punta: nunca se estima. */
function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.floor((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// 1. Hitos reales del journey MX (derivados de cases.case_subject_type, 0022)
// ---------------------------------------------------------------------------
// Regla dura: un caso cuenta como PROPIO solo con case_subject_type='DOCTOR_SELF'
// y como DE PACIENTE solo con 'PATIENT'. Si quedan casos 'UNKNOWN', el hito que
// esos casos podrían haber cumplido queda UNKNOWN. Tener casos NO es haber hecho
// el primer caso de paciente: eso era la inferencia que rompía la activación.

export interface MilestoneCaseRow {
  id: string;
  case_subject_type: string;
  is_new_case: boolean;
  fecha_ingreso: string;
  fecha_finalizado: string | null;
  fecha_entrega: string | null;
}

export interface CaseMilestones {
  own_case_status: MilestoneStatus;
  own_case_id: string | null;
  own_case_started_at: string | null;
  own_case_completed_at: string | null;
  first_patient_case_status: MilestoneStatus;
  first_patient_case_id: string | null;
  first_patient_case_started_at: string | null;
  first_patient_case_paid_at: string | null;
  first_patient_case_paid_source: PaidCaseSource | null;
  second_patient_case_status: SecondCaseStatus;
  second_patient_case_date: string | null;
  days_accreditation_to_own_case: number | null;
  days_own_case_to_first_patient: number | null;
  days_first_to_second_patient: number | null;
  cases_unclassified: number;
}

/** Un caso está terminado cuando tiene fecha_finalizado o fecha_entrega. */
function caseDone(c: MilestoneCaseRow): string | null {
  return c.fecha_finalizado ?? c.fecha_entrega ?? null;
}

export function deriveCaseMilestones(input: {
  accredited_at: string | null;
  cases: MilestoneCaseRow[];
  payments: PaymentRow[];
  first_paid_case_at: string | null;
}): CaseMilestones {
  const byIngreso = (a: MilestoneCaseRow, b: MilestoneCaseRow) =>
    Date.parse(a.fecha_ingreso) - Date.parse(b.fecha_ingreso);
  const cases = [...input.cases].sort(byIngreso);
  const unclassified = cases.filter((c) => c.case_subject_type === "UNKNOWN").length;

  // ---- caso propio: todas las filas DOCTOR_SELF son etapas del MISMO tratamiento
  const own = cases.filter((c) => c.case_subject_type === "DOCTOR_SELF");
  let ownStatus: MilestoneStatus;
  let ownId: string | null = null;
  let ownStart: string | null = null;
  let ownEnd: string | null = null;
  if (own.length > 0) {
    ownId = own[0].id;
    ownStart = own[0].fecha_ingreso;
    const ends = own.map(caseDone);
    if (ends.every((e) => e !== null)) {
      ownStatus = "COMPLETED";
      ownEnd = (ends as string[]).sort().at(-1) ?? null;
    } else {
      ownStatus = "IN_PROGRESS";
    }
  } else {
    // sin caso propio identificado: solo se puede afirmar "no lo hizo" cuando
    // TODOS sus casos están clasificados (o no tiene ninguno).
    ownStatus = unclassified > 0 ? "UNKNOWN" : "NOT_STARTED";
  }

  // ---- casos de paciente: se cuentan con la regla del KPI (is_new_case = etapa
  // I_1). Si ninguno viene marcado como caso nuevo, se usan todos los de paciente
  // (mejor esfuerzo, pero nunca inventa un caso que no existe).
  const patient = cases.filter((c) => c.case_subject_type === "PATIENT");
  const patientNew = patient.filter((c) => c.is_new_case);
  const counted = patientNew.length > 0 ? patientNew : patient;
  const first = counted[0] ?? null;
  const second = counted[1] ?? null;

  let firstStatus: MilestoneStatus;
  if (first) {
    firstStatus = caseDone(first) ? "COMPLETED" : "IN_PROGRESS";
  } else {
    firstStatus = unclassified > 0 ? "UNKNOWN" : "NOT_STARTED";
  }

  let secondStatus: SecondCaseStatus;
  if (second) secondStatus = "COMPLETED";
  else secondStatus = unclassified > 0 ? "UNKNOWN" : "NOT_STARTED";

  // ---- pago del primer caso de paciente: la verdad es el ledger `payments`.
  // Solo se atribuye un pago al hito cuando el hito EXISTE (si el primer caso de
  // paciente es UNKNOWN, un pago puede ser de su caso propio: no se atribuye).
  let paidAt: string | null = null;
  let paidSource: PaidCaseSource | null = null;
  if (first) {
    const linked = input.payments
      .filter((p) => p.case_id === first.id)
      .sort((a, b) => a.paid_at.localeCompare(b.paid_at))[0];
    if (linked) {
      paidAt = linked.paid_at;
      paidSource = "ledger_caso";
    } else if (input.payments.length > 0) {
      paidAt = [...input.payments].sort((a, b) => a.paid_at.localeCompare(b.paid_at))[0]
        .paid_at;
      paidSource = "ledger_doctor";
    } else if (input.first_paid_case_at) {
      paidAt = input.first_paid_case_at;
      paidSource = "doctors.first_paid_case_at";
    }
  }

  return {
    own_case_status: ownStatus,
    own_case_id: ownId,
    own_case_started_at: ownStart,
    own_case_completed_at: ownEnd,
    first_patient_case_status: firstStatus,
    first_patient_case_id: first?.id ?? null,
    first_patient_case_started_at: first?.fecha_ingreso ?? null,
    first_patient_case_paid_at: paidAt,
    first_patient_case_paid_source: paidSource,
    second_patient_case_status: secondStatus,
    second_patient_case_date: second?.fecha_ingreso ?? null,
    days_accreditation_to_own_case: daysBetween(input.accredited_at, ownStart),
    days_own_case_to_first_patient: daysBetween(ownStart, first?.fecha_ingreso ?? null),
    days_first_to_second_patient: daysBetween(
      first?.fecha_ingreso ?? null,
      second?.fecha_ingreso ?? null
    ),
    cases_unclassified: unclassified,
  };
}

// ---------------------------------------------------------------------------
// 2. Calidad del dato de interacción
// ---------------------------------------------------------------------------
// "Nadie lo llamó en 90 días" y "no sabemos si alguien lo llamó" llevan a
// acciones opuestas. Esta función decide cuál de las dos se puede afirmar.
//
// Heurística (exacta):
//   POOR    → hay actividades pero 0 clasificadas (hoy: TODOS los doctores, las
//             4.257 actividades son notas importadas con engagement UNKNOWN).
//             También POOR sin ninguna actividad: tampoco hay con qué decidir.
//   PARTIAL → menos del 50% clasificadas, o ≥50% pero ninguna MEANINGFUL.
//   GOOD    → ≥50% clasificadas y al menos una MEANINGFUL.
export function deriveInteractionQuality(counts: {
  total: number;
  unknown: number;
  meaningful: number;
}): InteractionDataQuality {
  const classified = Math.max(0, counts.total - counts.unknown);
  if (counts.total === 0 || classified === 0) return "POOR";
  if (classified / counts.total < 0.5) return "PARTIAL";
  return counts.meaningful > 0 ? "GOOD" : "PARTIAL";
}

// ---------------------------------------------------------------------------
// 3. Impacto de servicio (¿esto puede dañar la confianza del doctor?)
// ---------------------------------------------------------------------------

/** severity del motor (alert_severity) → PUNTAJE BASE, no piso. La regla del
 *  motor es binaria ("superó el umbral"): una alerta 'alta' sin impacto real
 *  (sin paciente esperando, con dos días de atraso) tiene que poder quedar
 *  MEDIUM. Ese es justamente el punto de este módulo: dejar de tratar "hay una
 *  alerta" como "hay un problema grave". */
export const ALERT_SEVERITY_BASE: Record<
  string,
  { severity: ServiceSeverity; points: number }
> = {
  critica: { severity: "CRITICAL", points: 55 },
  alta: { severity: "HIGH", points: 40 },
  media: { severity: "MEDIUM", points: 25 },
  info: { severity: "INFORMATIONAL", points: 5 },
};

/** Escala del trust_risk_score. CRITICAL exige acumular varios factores duros
 *  (mucho atraso + paciente esperando + repetido/sin responder): con las tres
 *  reglas de servicio de hoy el techo real es ~85. */
function severityFromScore(score: number): ServiceSeverity {
  if (score >= 80) return "CRITICAL";
  if (score >= 65) return "HIGH";
  if (score >= 45) return "MEDIUM";
  if (score >= 25) return "LOW";
  return "INFORMATIONAL";
}

export interface ServiceImpactInput {
  /** Severidad del motor, solo informativa: NO es piso de la severidad final. */
  base_severity: ServiceSeverity;
  base_points: number;
  /** 'hard' = fechas duras del sistema de producción (video listo sin aprobar,
   *  días en etapa). 'soft' = expectativa estadística o falta de movimiento, que
   *  puede ser un hueco de datos y no un problema real. */
  evidence: "hard" | "soft";
  /** Días POR ENCIMA de lo que la regla espera (no los días totales). */
  days_overdue: number | null;
  expected_days: number | null;
  blocked_case: boolean;
  unanswered_request: boolean;
  repeated: boolean;
  patient_affected: boolean;
}

export interface ServiceImpact {
  severity: ServiceSeverity;
  confidence: ServiceConfidence;
  trust_risk_score: number;
  impact_factors: string[];
}

/** Deriva impacto cuando NADIE lo calificó a mano. Nunca devuelve CONFIRMED:
 *  eso solo puede venir de alerts.service_confidence cargado por una persona. */
export function deriveServiceImpact(input: ServiceImpactInput): ServiceImpact {
  const factors: string[] = [];
  let pts = input.base_points;

  if (input.days_overdue != null && input.days_overdue > 0) {
    pts += input.days_overdue >= 30 ? 20 : input.days_overdue >= 14 ? 12 : 6;
    factors.push(
      `dias_atraso (+${input.days_overdue}d${
        input.expected_days != null ? ` sobre ${input.expected_days} esperados` : ""
      }${
        // más de un año de atraso casi siempre es un caso viejo que nadie cerró,
        // no un doctor esperando: se marca para que el agente no dramatice
        input.days_overdue > 365 ? "; dato dudoso, puede ser un caso sin cerrar" : ""
      })`
    );
    if (input.expected_days != null) factors.push("sla_incumplido");
  }
  if (input.blocked_case) {
    pts += 8;
    factors.push("caso_bloqueado");
  }
  if (input.unanswered_request) {
    pts += 8;
    factors.push("pedido_sin_responder (el doctor escribió último)");
  }
  if (input.repeated) {
    pts += 10;
    factors.push("problema_repetido");
  }
  if (input.patient_affected) {
    pts += 14;
    factors.push("paciente_afectado");
  }

  const score = Math.max(0, Math.min(100, Math.round(pts)));

  return {
    severity: severityFromScore(score),
    confidence: input.evidence === "hard" ? "LIKELY" : "POSSIBLE",
    trust_risk_score: score,
    impact_factors: factors,
  };
}

function storedFactors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is string => typeof f === "string" && f.length > 0);
}

/** Orden de severidad, para poder aplicar un tope sin depender del orquestador. */
const SEVERITY_RANK_CTX: Record<ServiceSeverity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFORMATIONAL: 1,
};

const SEVERITY_ES: Record<ServiceSeverity, string> = {
  CRITICAL: "crítico",
  HIGH: "alto",
  MEDIUM: "medio",
  LOW: "bajo",
  INFORMATIONAL: "informativo",
};

/** Una línea es-MX con el estado de servicio. Sin problemas detectados NO es
 *  lo mismo que sin problemas: lo dice explícitamente. */
export function buildServiceSummary(
  issues: ServiceIssue[],
  trustRisk: number | null
): string {
  if (issues.length === 0) {
    return "Sin problemas de servicio detectados (no hay alertas abiertas ni casos trabados; ausencia de alerta no prueba ausencia de problema).";
  }
  const counts = new Map<ServiceSeverity, number>();
  for (const i of issues) counts.set(i.severity, (counts.get(i.severity) ?? 0) + 1);
  const desglose = (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"] as const)
    .filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${SEVERITY_ES[s]}`)
    .join(", ");
  const revisados = issues.filter((i) => i.source === "alerta_revisada").length;
  return `${issues.length} problema(s) de servicio (${desglose}) · riesgo de confianza ${trustRisk ?? "—"}/100 · ${revisados} calificado(s) por una persona, ${issues.length - revisados} estimado(s) por regla.`;
}

/**
 * Arma el DoctorContext.
 *
 * `client` permite inyectar un cliente distinto del de sesión para poder correr
 * el contexto FUERA de un request (scripts de evaluación, dry-runs). En la app
 * siempre se omite: se usa la sesión del usuario y corre RLS. Es solo lectura en
 * ambos casos — esta función nunca escribe.
 */
export async function buildDoctorContext(
  doctorId: string,
  client?: SupabaseClient
): Promise<DoctorContext> {
  const supabase = client ?? (await createAiReadClient());

  const [
    { data: doctorRaw, error: doctorError },
    { data: casesRaw, error: casesError },
    { data: oppsRaw, error: oppsError },
    { data: tasksRaw, error: tasksError },
    { data: activitiesRaw, error: activitiesError },
    { data: alertsRaw, error: alertsError },
    { data: paymentsRaw, error: paymentsError },
    { count: actTotalCount, error: actTotalError },
    { count: actUnknownCount, error: actUnknownError },
    { count: actMeaningfulCount, error: actMeaningfulError },
    { data: waRaw },
    { data: contactsRaw },
    { data: aiProfileRaw },
    { data: recsRaw },
    { data: syncRaw },
    { data: profilesRaw },
  ] = await Promise.all([
    supabase.from("doctors").select("*").eq("id", doctorId).single(),
    supabase
      .from("cases")
      .select("*")
      .eq("doctor_id", doctorId)
      .eq("is_demo", false)
      .order("fecha_ingreso", { ascending: false }),
    supabase
      .from("opportunities")
      .select("id, patient_name, stage, stage_entered_at, probability, amount_mxn")
      .eq("doctor_id", doctorId)
      .eq("is_demo", false)
      .not("stage", "in", "(ganada,perdida)")
      .order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select("id, title, type, due_date, automation_rule_id, created_at")
      .eq("doctor_id", doctorId)
      .eq("status", "pendiente")
      .eq("is_demo", false)
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("activities")
      .select("type, occurred_at, summary, outcome, engagement_quality")
      .eq("doctor_id", doctorId)
      .eq("is_demo", false)
      .order("occurred_at", { ascending: false })
      .limit(200),
    // TODAS las alertas (no solo abiertas): las cerradas dicen si el problema se
    // repite, que es parte del impacto real sobre la confianza.
    supabase
      .from("alerts")
      .select(
        "id, rule_key, opportunity_id, severity, status, title, reason, created_at, service_confidence, trust_risk_score, impact_factors"
      )
      .eq("doctor_id", doctorId)
      .eq("is_demo", false),
    // ledger de pagos = verdad del KPI "caso pagado"
    supabase
      .from("payments")
      .select("paid_at, case_id")
      .eq("doctor_id", doctorId)
      .eq("is_demo", false)
      .order("paid_at", { ascending: true }),
    // conteos de engagement sobre TODAS las actividades (la ventana de 200 no
    // alcanza para medir calidad de dato)
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("doctor_id", doctorId)
      .eq("is_demo", false),
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("doctor_id", doctorId)
      .eq("is_demo", false)
      .eq("engagement_quality", "UNKNOWN"),
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("doctor_id", doctorId)
      .eq("is_demo", false)
      .eq("engagement_quality", "MEANINGFUL"),
    supabase
      .from("wa_conversations")
      // Sin chat_name ni phone: no se usan y traerlos solo invita a que vuelvan al
      // prompt de un descuido. Ver lib/ai/pii.ts.
      .select("unanswered, activity_bucket")
      .eq("doctor_id", doctorId),
    supabase
      .from("contacts")
      .select("nombre, phone, whatsapp, es_principal")
      .eq("doctor_id", doctorId),
    // tablas ai_* (migración 0017): si aún no existen, data llega null y se degrada
    supabase.from("doctor_ai_profile").select("*").eq("doctor_id", doctorId).maybeSingle(),
    supabase
      .from("ai_recommendations")
      .select("*")
      .eq("doctor_id", doctorId)
      .eq("status", "propuesta")
      .order("created_at", { ascending: false }),
    supabase
      .from("sync_runs")
      .select("finished_at")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1),
    supabase.from("profiles").select("id, nombre"),
  ]);

  if (doctorError || !doctorRaw) {
    throw new Error(`Doctor ${doctorId} no encontrado`);
  }
  // Una query caída se vería como "sin datos" y el agente concluiría sobre un
  // vacío falso (p.ej. "no tiene casos"). Mejor cortar que analizar en falso.
  const dataErrors = [
    ["casos", casesError],
    ["oportunidades", oppsError],
    ["tareas", tasksError],
    ["actividades", activitiesError],
    ["alertas", alertsError],
    ["pagos", paymentsError],
    ["conteo de actividades", actTotalError],
    ["conteo de actividades sin clasificar", actUnknownError],
    ["conteo de contactos significativos", actMeaningfulError],
  ].filter(([, e]) => e) as [string, { message: string }][];
  if (dataErrors.length > 0) {
    throw new Error(
      `No se pudo armar el contexto del doctor: fallaron ${dataErrors
        .map(([name, e]) => `${name} (${e.message})`)
        .join(", ")}`
    );
  }
  const doctor = doctorRaw as Doctor;
  const cases = (casesRaw ?? []) as CaseRow[];
  const opps = (oppsRaw ?? []) as OppRow[];
  const taskRows = (tasksRaw ?? []) as TaskRow[];
  const acts = (activitiesRaw ?? []) as ActivityRow[];
  const allAlerts = (alertsRaw ?? []) as AlertRow[];
  const alerts = allAlerts.filter((a) => a.status === "abierta");
  const payments = (paymentsRaw ?? []) as PaymentRow[];
  const waChats = (waRaw ?? []) as WaRow[];
  const contacts = (contactsRaw ?? []) as ContactRow[];
  const aiProfile = (aiProfileRaw ?? null) as DoctorAiProfileRow | null;
  const openRecommendations = (recsRaw ?? []) as AiRecommendationRow[];

  const profileName = new Map(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [p.id, p.nombre])
  );

  const today = todayMX();
  const now = Date.now();

  // ---------- contacto ----------
  // El contacto significativo YA NO se deriva del tipo de actividad: sale de
  // activities.engagement_quality (0022). El tipo no dice si la conversación fue
  // sustantiva (una llamada puede ser "te llamo la semana que viene").
  const lastTouch = acts[0]?.occurred_at ?? null;
  const lastMeaningful =
    acts.find((a) => a.engagement_quality === "MEANINGFUL")?.occurred_at ?? null;
  const engagementTotal = actTotalCount ?? 0;
  const engagementUnknown = actUnknownCount ?? 0;
  const engagementMeaningful = actMeaningfulCount ?? 0;
  const engagementClassified = Math.max(0, engagementTotal - engagementUnknown);
  const interactionDataQuality = deriveInteractionQuality({
    total: engagementTotal,
    unknown: engagementUnknown,
    meaningful: engagementMeaningful,
  });

  // ---------- casos ----------
  const cases30 = cases.filter(
    (c) => c.is_new_case && Date.parse(c.fecha_ingreso) > now - 30 * DAY_MS
  ).length;
  const cases90 = cases.filter(
    (c) => c.is_new_case && Date.parse(c.fecha_ingreso) > now - 90 * DAY_MS
  ).length;
  const openCases = cases.filter((c) => !c.fecha_finalizado && !c.fecha_entrega);

  // ---------- casos estancados ----------
  // El flujo real de un caso (criterio de Pancho, 9/8/26):
  //   ingresa → documentación completa → ortodoncia lo mueve → se publica el
  //   video → EL DOCTOR LO APRUEBA → se imprime → se manda → tratamiento en curso.
  //
  // La consecuencia que cambia todo: DESPUÉS DEL ENVÍO puede pasar un año sin
  // novedades, y eso es normal — el tratamiento está andando. Un caso impreso no
  // es un problema de servicio por más quieto que esté. Antes se contaban por
  // "días sin movimiento de etapa" y eso metía 387 tratamientos en curso (el 59%
  // de los casos abiertos) como si fueran atrasos críticos.
  //
  // Donde SÍ se traba, y donde hay que pushear, es en dos puntos:
  //   1. DOCUMENTACIÓN INCOMPLETA — el doctor no mandó los registros.
  //   2. VIDEO SIN APROBAR — el doctor tiene que aprobar y no aprobó.
  // Los dos son pelota del DOCTOR: la acción es empujar, no disculparse.
  // Y hay dos internos, que son pelota nuestra: documentado sin video
  // (ortodoncia) y aprobado sin imprimir (producción).
  const stalledMeta = new Map<
    string,
    {
      evidence: "hard" | "soft";
      expected: number;
      overdue: number;
      patient: boolean;
      /** true = la pelota la tiene el doctor ⇒ pushear, no pedir disculpas. */
      doctorSide: boolean;
      /** Sin fecha de cierre y muy viejo: casi seguro es un hueco de dato. */
      likelyStaleData: boolean;
    }
  >();
  const stalledCases: StalledCase[] = [];
  for (const c of openCases) {
    const label = c.id_externo ?? c.noloco_case_id;

    // Impreso = enviado. A partir de acá el silencio es el tratamiento, no un
    // atraso. No se reporta como problema de servicio bajo ninguna antigüedad.
    if (c.fecha_impresion) continue;

    let issue: string | null = null;
    let days: number | null = null;
    let expected = EXPECTED_STAGE_MOVE_DAYS;
    let evidence: "hard" | "soft" = "hard";
    let doctorSide = false;

    if (!c.fecha_documentacion) {
      // 1. Ingresó y no llegó la documentación: la pelota es del doctor.
      days = daysSince(c.fecha_ingreso);
      expected = EXPECTED_DOCUMENTATION_DAYS;
      issue = `documentación incompleta hace ${days ?? "?"} días (falta que el doctor mande registros)`;
      doctorSide = true;
    } else if (c.fecha_video && !c.fecha_aprobacion_video) {
      // 2. Video publicado y sin aprobar: la pelota es del doctor. ACÁ SE PUSHEA.
      days = daysSince(c.fecha_video);
      expected = EXPECTED_VIDEO_APPROVAL_DAYS;
      issue = `video publicado sin aprobar hace ${days ?? "?"} días (esperando la aprobación del doctor)`;
      doctorSide = true;
    } else if (!c.fecha_video) {
      // 3. Documentado y sin video: lo tiene ortodoncia. Pelota nuestra.
      days = daysSince(c.fecha_documentacion);
      expected = EXPECTED_PLANNING_DAYS;
      issue = `documentado sin video de planificación hace ${days ?? "?"} días (lo tiene ortodoncia)`;
      evidence = "soft";
    } else if (c.fecha_aprobacion_video && !c.fecha_impresion) {
      // 4. Aprobado y sin imprimir: lo tiene producción. Pelota nuestra.
      days = daysSince(c.fecha_aprobacion_video);
      expected = EXPECTED_PRINT_DAYS;
      issue = `aprobado y sin imprimir hace ${days ?? "?"} días (lo tiene producción)`;
      evidence = "soft";
    }

    if (issue === null || days === null || days <= expected) continue;

    // Un caso parado más de un año en un punto del flujo, en una base donde
    // fecha_entrega no se importa nunca y solo 359 de 1.017 tienen cierre, casi
    // seguro es un hueco de dato y no un paciente esperando. Se sigue mostrando
    // —hay que cerrarlo— pero no puede secuestrar el trabajo comercial del doctor.
    const likelyStaleData = days > STALE_DATA_DAYS;

    stalledCases.push({
      case_id: c.id,
      label,
      etapa: c.etapa,
      issue: likelyStaleData
        ? `${issue} — más de un año: probablemente un caso sin cerrar, no un atraso vivo`
        : issue,
      days_stalled: days,
    });
    stalledMeta.set(c.id, {
      evidence: likelyStaleData ? "soft" : evidence,
      expected,
      overdue: days - expected,
      // "paciente afectado" solo se afirma si el caso está vivo: en uno de más de
      // un año sin cierre no hay ningún dato que sostenga que alguien espera.
      patient: Boolean(c.paciente) && !likelyStaleData,
      doctorSide,
      likelyStaleData,
    });
  }
  stalledCases.sort((a, b) => b.days_stalled - a.days_stalled);
  const stalledTop = stalledCases.slice(0, 10);

  // ---------- estados derivados de acreditación / activación ----------
  let accreditationStatus = "no acreditado";
  if (doctor.is_accredited) accreditationStatus = "acreditado";
  else if (doctor.acquisition_stage === "acreditacion_agendada")
    accreditationStatus = "agendada";
  else if (doctor.acquisition_stage === "interes_acreditacion")
    accreditationStatus = "interesado";

  // ---------- cadena de hitos MX (0022) ----------
  // ACREDITADO → CASO PROPIO → 1er CASO DE PACIENTE → 2º. Se deriva de
  // cases.case_subject_type; lo que no está clasificado queda UNKNOWN.
  const journey = deriveCaseMilestones({
    accredited_at: doctor.accredited_at,
    cases,
    payments,
    first_paid_case_at: doctor.first_paid_case_at,
  });

  // ---------- tareas: excluir el flood de automation (5.060 pendientes) ----------
  const horizonISO = new Date(Date.parse(today) + 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const relevantTasks = taskRows.filter(
    (t) => !t.automation_rule_id || (t.due_date != null && t.due_date <= horizonISO)
  );
  const tasks: TaskSummary[] = relevantTasks.slice(0, 20).map((t) => ({
    id: t.id,
    title: t.title,
    type: t.type,
    due_date: t.due_date,
    overdue: t.due_date != null && t.due_date < today,
    from_automation: t.automation_rule_id != null,
  }));
  const knownCommitments = taskRows
    .filter((t) => !t.automation_rule_id)
    .slice(0, 10)
    .map((t) => (t.due_date ? `${t.title} (vence ${t.due_date})` : t.title));

  // ---------- impacto de servicio ----------
  // La pregunta NO es "¿hay una alerta?" sino "¿esto puede dañar la confianza
  // del doctor?". Si un humano calificó la alerta (service_confidence /
  // trust_risk_score / impact_factors de 0022) se usa su calificación; si no, se
  // deriva y se declara como estimación (nunca CONFIRMED).
  const unansweredWa = waChats.some((w) => w.unanswered);
  // "repetido" = el motor ya había levantado esta misma regla antes para este
  // doctor (cuenta las cerradas, por eso se traen todas las alertas).
  const alertsByRule = new Map<string, number>();
  for (const a of allAlerts) {
    alertsByRule.set(a.rule_key, (alertsByRule.get(a.rule_key) ?? 0) + 1);
  }

  const alertIssues = alerts
    .filter((a) => SERVICE_RULE_KEYS.has(a.rule_key))
    .map((a): ServiceIssue => {
      const base = ALERT_SEVERITY_BASE[a.severity] ?? {
        severity: "MEDIUM" as ServiceSeverity,
        points: 40,
      };
      let evidence: "hard" | "soft" = "soft";
      let expected: number | null = null;
      let overdue: number | null = null;
      let blocked = false;
      let patientAffected = false;
      // La alerta no tiene ningún caso vivo que la sostenga ⇒ tope de severidad.
      let staleAlert = false;

      if (a.rule_key === "caso_atrasado") {
        // atraso contra el ritmo propio del doctor (la regla dispara a 1,25x)
        const expectedDays =
          doctor.avg_interval_days != null
            ? Math.round(doctor.avg_interval_days * 1.25)
            : null;
        const actual = daysSince(doctor.last_new_case_at);
        expected = expectedDays;
        overdue = expectedDays != null && actual != null ? actual - expectedDays : null;
        // ritmo 'personal' = calculado con SUS casos; 'cohort' = expectativa
        // estadística prestada de la cohorte ⇒ evidencia blanda.
        evidence = doctor.health_confidence === "personal" ? "hard" : "soft";
      } else if (a.rule_key === "aprobacion_pendiente") {
        // Sobre la lista COMPLETA (no el top 10). Se busca un caso VIVO: uno de
        // más de un año sin cierre no sostiene una alerta crítica, porque en
        // esta base el cierre no se importa (fecha_entrega 0 de 1.017).
        const vivos = stalledCases.filter((s) => {
          const m = stalledMeta.get(s.case_id);
          return m?.evidence === "hard" && !m.likelyStaleData;
        });
        const worst = vivos.sort((x, y) => y.days_stalled - x.days_stalled)[0];
        const meta = worst ? stalledMeta.get(worst.case_id) : undefined;
        expected = EXPECTED_VIDEO_APPROVAL_DAYS;
        overdue = meta?.overdue ?? null;
        // Sin ningún caso vivo detrás, la alerta describe un hueco de dato.
        evidence = meta ? "hard" : "soft";
        // La aprobación la debe el DOCTOR: no hay nada bloqueado de nuestro lado.
        // La acción es pushear la aprobación, no disculparse por una demora.
        blocked = false;
        patientAffected = meta?.patient ?? false;
        if (!meta) staleAlert = true;
      } else if (a.rule_key === "oportunidad_estancada") {
        const opp = opps.find((o) => o.id === a.opportunity_id);
        if (opp) {
          expected = EXPECTED_OPP_STAGE_DAYS[opp.stage] ?? 7;
          const inStage = daysSince(opp.stage_entered_at);
          overdue = inStage != null ? inStage - expected : null;
          patientAffected = Boolean(opp.patient_name);
        }
        evidence = "hard";
        blocked = true;
      }

      const derived = deriveServiceImpact({
        base_severity: base.severity,
        base_points: base.points,
        evidence,
        days_overdue: overdue,
        expected_days: expected,
        blocked_case: blocked,
        unanswered_request: unansweredWa,
        repeated: (alertsByRule.get(a.rule_key) ?? 0) > 1,
        patient_affected: patientAffected,
      });

      // lo cargado por una persona gana sobre lo derivado, campo por campo
      const stored = storedFactors(a.impact_factors);
      const reviewed =
        a.service_confidence != null || a.trust_risk_score != null || stored.length > 0;
      // Tope por hueco de dato, salvo que una persona ya lo haya calificado.
      const capped = staleAlert && !reviewed;
      const severity: ServiceSeverity = capped
        ? SEVERITY_RANK_CTX[derived.severity] > SEVERITY_RANK_CTX.MEDIUM
          ? "MEDIUM"
          : derived.severity
        : derived.severity;
      return {
        kind: "alerta",
        detail:
          (a.reason ? `${a.title} — ${a.reason}` : a.title) +
          (capped
            ? " — sin ningún caso vivo detrás: probablemente casos sin cerrar"
            : ""),
        since: a.created_at,
        severity,
        confidence: a.service_confidence ?? (capped ? "POSSIBLE" : derived.confidence),
        trust_risk_score:
          a.trust_risk_score ??
          (capped ? Math.min(derived.trust_risk_score, 45) : derived.trust_risk_score),
        impact_factors: stored.length > 0 ? stored : derived.impact_factors,
        source: reviewed ? "alerta_revisada" : "derivado",
        alert_severity: a.severity,
        rule_key: a.rule_key,
      };
    });

  const stalledIssues = stalledTop.map((s): ServiceIssue => {
    const meta = stalledMeta.get(s.case_id);
    // base baja a propósito: los días ya suman por dias_atraso, no se cuentan dos veces
    const basePoints = s.days_stalled >= 30 ? 40 : s.days_stalled >= 14 ? 28 : 18;
    const baseSeverity: ServiceSeverity =
      s.days_stalled >= 30 ? "HIGH" : s.days_stalled >= 14 ? "MEDIUM" : "LOW";
    const derived = deriveServiceImpact({
      base_severity: baseSeverity,
      base_points: basePoints,
      evidence: meta?.evidence ?? "soft",
      days_overdue: meta?.overdue ?? null,
      expected_days: meta?.expected ?? null,
      // "caso bloqueado" describe un caso trabado del lado de KS. Si la pelota
      // la tiene el doctor (documentación o aprobación pendiente) no hay nada
      // bloqueado de nuestro lado: hay que empujar, no disculparse.
      blocked_case: !(meta?.doctorSide ?? false),
      unanswered_request: unansweredWa,
      repeated: false,
      patient_affected: meta?.patient ?? false,
    });
    // Un caso de más de un año sin cierre no puede desplazar todo el trabajo
    // comercial del doctor: se muestra, pero como problema de DATO.
    const stale = meta?.likelyStaleData ?? false;
    const severity: ServiceSeverity = stale
      ? SEVERITY_RANK_CTX[derived.severity] > SEVERITY_RANK_CTX.MEDIUM
        ? "MEDIUM"
        : derived.severity
      : derived.severity;
    return {
      kind: "caso_estancado",
      detail: `Caso ${s.label}${s.etapa ? ` (${s.etapa})` : ""}: ${s.issue}${
        meta?.doctorSide ? " · la pelota la tiene el doctor: hay que pushear" : ""
      }`,
      since: null,
      severity,
      confidence: stale ? "POSSIBLE" : derived.confidence,
      trust_risk_score: stale
        ? Math.min(derived.trust_risk_score, 45)
        : derived.trust_risk_score,
      impact_factors: stale
        ? [...derived.impact_factors, "dato_sin_cierre"]
        : derived.impact_factors,
      source: "derivado",
      alert_severity: null,
      rule_key: null,
    };
  });

  const serviceIssues: ServiceIssue[] = [...alertIssues, ...stalledIssues].sort(
    (a, b) => b.trust_risk_score - a.trust_risk_score
  );
  const trustRisk =
    serviceIssues.length > 0
      ? Math.max(...serviceIssues.map((i) => i.trust_risk_score))
      : null;
  const serviceSummary = buildServiceSummary(serviceIssues, trustRisk);

  // ---------- notas / historia ----------
  const notes = acts
    .filter((a) => a.type === "nota" && (a.summary || a.outcome))
    .slice(0, 5);
  const notesSummary = notes.length
    ? notes
        .map((n) => {
          const txt = [n.summary, n.outcome].filter(Boolean).join(" — ");
          return `[${n.occurred_at.slice(0, 10)}] ${truncate(txt, 140)}`;
        })
        .join("\n")
    : null;

  const actLine = (a: ActivityRow, fallback: string) =>
    `[${a.occurred_at.slice(0, 10)}] ${truncate(a.summary ?? fallback, 100)}${
      a.outcome ? ` — ${truncate(a.outcome, 60)}` : ""
    }`;
  const trainingHistory = acts
    .filter((a) => a.type === "revision_clinica")
    .slice(0, 10)
    .map((a) => actLine(a, "Revisión clínica"));
  const keepdayHistory = acts
    .filter((a) => a.type === "keepday")
    .slice(0, 10)
    .map((a) => actLine(a, "KeepDay"));

  const recentActivity: ActivitySummary[] = acts.slice(0, 15).map((a) => ({
    type: a.type,
    date: a.occurred_at,
    summary: a.summary,
    outcome: a.outcome,
    meaningful: a.engagement_quality === "MEANINGFUL",
    engagement_quality: a.engagement_quality,
  }));

  // ---------- oportunidades abiertas ----------
  const openOpportunities: OpportunitySummary[] = opps.slice(0, 10).map((o) => ({
    id: o.id,
    // El nombre del paciente NO viaja: referencia corta y estable (lib/ai/pii.ts).
    ref: refOportunidad(o.id),
    stage: o.stage,
    days_in_stage: daysSince(o.stage_entered_at) ?? 0,
    probability: o.probability,
    amount_mxn: o.amount_mxn,
  }));

  // ---------- canal WhatsApp (metadata Periskope; wa_messages está vacía) ----------
  const waSorted = [...waChats].sort(
    (a, b) => (a.unanswered ? 0 : 1) - (b.unanswered ? 0 : 1)
  );
  const wa = waSorted[0] ?? null;

  // teléfono: fallback al contacto principal si el doctor no tiene cargado
  const principal = contacts.find((c) => c.es_principal) ?? contacts[0] ?? null;

  const syncRow = (syncRaw ?? [])[0] as { finished_at: string | null } | undefined;
  const dataAsOf = syncRow?.finished_at?.slice(0, 10) ?? today;

  return {
    doctor_id: doctor.id,
    name: doctor.nombre,
    city: doctor.city ?? doctor.state,
    zona: doctor.zona,
    clinic: doctor.clinic_name,
    // Solo si el canal existe. El número se usa al mandar, y eso pasa en la pantalla
    // con la sesión del usuario, no acá. Ver lib/ai/pii.ts.
    has_phone: Boolean(doctor.phone ?? principal?.phone),
    has_whatsapp: Boolean(doctor.whatsapp ?? principal?.whatsapp),
    owner: doctor.owner_id ? (profileName.get(doctor.owner_id) ?? null) : null,
    clinical_owner: doctor.clinical_owner_id
      ? (profileName.get(doctor.clinical_owner_id) ?? null)
      : null,
    categoria: doctor.categoria,
    lifecycle: doctor.lifecycle_stage,
    is_accredited: doctor.is_accredited,
    acquisition_stage: doctor.acquisition_stage,
    activation_stage: doctor.activation_stage,
    accreditation_status: accreditationStatus,
    accreditation_date: doctor.accredited_at,
    days_since_accreditation: daysSince(doctor.accredited_at),
    own_case_status: journey.own_case_status,
    own_case_id: journey.own_case_id,
    own_case_started_at: journey.own_case_started_at,
    own_case_completed_at: journey.own_case_completed_at,
    first_patient_case_status: journey.first_patient_case_status,
    first_patient_case_id: journey.first_patient_case_id,
    first_patient_case_started_at: journey.first_patient_case_started_at,
    first_patient_case_paid_at: journey.first_patient_case_paid_at,
    first_patient_case_paid_source: journey.first_patient_case_paid_source,
    first_patient_case_date:
      journey.first_patient_case_started_at ?? journey.first_patient_case_paid_at,
    second_patient_case_status: journey.second_patient_case_status,
    second_patient_case_date: journey.second_patient_case_date,
    days_accreditation_to_own_case: journey.days_accreditation_to_own_case,
    days_own_case_to_first_patient: journey.days_own_case_to_first_patient,
    days_first_to_second_patient: journey.days_first_to_second_patient,
    cases_unclassified: journey.cases_unclassified,
    payments_count: payments.length,
    first_payment_at: payments[0]?.paid_at ?? null,
    // cases_total = casos NUEVOS históricos (is_new_case, la regla del KPI)
    cases_total: doctor.new_case_count,
    cases_30d: cases30,
    cases_90d: cases90,
    historical_case_frequency: {
      avg_interval_days: doctor.avg_interval_days,
      expected_next_case_at: doctor.expected_next_case_at,
      confidence:
        doctor.avg_interval_days != null
          ? "personal"
          : doctor.health_confidence === "cohort"
            ? "cohort"
            : "insuficiente",
    },
    days_since_last_case: daysSince(doctor.last_new_case_at),
    open_cases: openCases.length,
    stalled_cases: stalledTop,
    open_opportunities: openOpportunities,
    last_meaningful_contact: lastMeaningful,
    days_since_meaningful_contact: daysSince(lastMeaningful),
    interaction_data_quality: interactionDataQuality,
    engagement_unknown_count: engagementUnknown,
    engagement_classified_count: engagementClassified,
    last_touch: lastTouch,
    next_action: doctor.recommended_action,
    priority: {
      score: doctor.priority_score,
      bucket: doctor.priority_bucket,
      reasons: doctor.priority_reasons ?? [],
    },
    health: { score: doctor.health_score, confidence: doctor.health_confidence },
    potential_score: doctor.potential_override ?? doctor.potential_computed,
    tasks,
    competitors: doctor.competitor_brands ?? [],
    aligner_experience: aiProfile?.experience_with_aligners ?? null,
    clinical_confidence: aiProfile?.clinical_confidence ?? "desconocida",
    main_objection: aiProfile?.known_objections ?? aiProfile?.main_concerns ?? null,
    lead_source: doctor.source,
    notes_summary: notesSummary,
    relationship_summary: aiProfile?.relationship_notes ?? null,
    recent_activity: recentActivity,
    training_history: trainingHistory,
    keepday_history: keepdayHistory,
    kos_status: null, // V1: sin fuente de datos KOS en el CRM
    campaign_history: [], // V1: campaigns sin vincular a doctores
    known_commitments: knownCommitments,
    service_issues: serviceIssues,
    trust_risk_score: trustRisk,
    service_summary: serviceSummary,
    // Sin chat_name ni phone: el nombre del chat suele ser el de una persona, y el
    // número no hace falta para razonar. Queda lo que el agente sí usa.
    wa_channel: wa
      ? { unanswered: wa.unanswered, activity_bucket: wa.activity_bucket }
      : null,
    ai_profile: aiProfile,
    open_recommendations: openRecommendations,
    data_as_of: dataAsOf,
  };
}

const MILESTONE_ES: Record<MilestoneStatus, string> = {
  NOT_STARTED: "NO INICIADO",
  IN_PROGRESS: "EN CURSO",
  COMPLETED: "COMPLETADO",
  UNKNOWN: "DESCONOCIDO",
};

const PAID_SOURCE_ES: Record<PaidCaseSource, string> = {
  ledger_caso: "ledger, atado a ese caso",
  ledger_doctor: "ledger a nivel DOCTOR: el pago no está atado a un caso",
  "doctors.first_paid_case_at": "doctors.first_paid_case_at, sin fila de ledger",
};

/** Cadena de hitos con los UNKNOWN explícitos. Es el corazón del módulo: si los
 *  casos no están clasificados, el bloque lo DICE en vez de inventar el hito. */
function milestoneLines(ctx: DoctorContext): string[] {
  const f = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
  const out: string[] = [];
  const allUnknown =
    ctx.own_case_status === "UNKNOWN" &&
    ctx.first_patient_case_status === "UNKNOWN" &&
    ctx.second_patient_case_status === "UNKNOWN";
  if (allUnknown) {
    out.push(
      "- Hitos MX (acreditación → caso propio → 1er paciente → 2º): los TRES DESCONOCIDOS"
    );
  } else {
    const own = `propio ${MILESTONE_ES[ctx.own_case_status]}${
      ctx.own_case_started_at ? ` (${f(ctx.own_case_started_at)}` : ""
    }${ctx.own_case_completed_at ? `→${f(ctx.own_case_completed_at)}` : ""}${
      ctx.own_case_started_at ? ")" : ""
    }`;
    const first = `1er paciente ${MILESTONE_ES[ctx.first_patient_case_status]}${
      ctx.first_patient_case_started_at
        ? ` (${f(ctx.first_patient_case_started_at)})`
        : ""
    }`;
    const second = `2º ${MILESTONE_ES[ctx.second_patient_case_status]}${
      ctx.second_patient_case_date ? ` (${f(ctx.second_patient_case_date)})` : ""
    }`;
    out.push(`- Hitos MX (acreditación → caso propio → 1er paciente → 2º): ${own} · ${first} · ${second}`);
  }

  const tramos: string[] = [];
  if (ctx.days_accreditation_to_own_case != null)
    tramos.push(`acreditación→propio ${ctx.days_accreditation_to_own_case}d`);
  if (ctx.days_own_case_to_first_patient != null)
    tramos.push(`propio→1er paciente ${ctx.days_own_case_to_first_patient}d`);
  if (ctx.days_first_to_second_patient != null)
    tramos.push(`1º→2º ${ctx.days_first_to_second_patient}d`);
  if (tramos.length) out.push(`- Tiempos entre hitos: ${tramos.join(" · ")}`);

  if (ctx.first_patient_case_paid_at) {
    out.push(
      `- Pago del 1er caso de paciente: ${f(ctx.first_patient_case_paid_at)} (${
        ctx.first_patient_case_paid_source
          ? PAID_SOURCE_ES[ctx.first_patient_case_paid_source]
          : "—"
      })`
    );
  }
  if (ctx.cases_unclassified > 0) {
    out.push(
      `- ⚠ ${ctx.cases_unclassified} caso(s) SIN CLASIFICAR (case_subject_type='UNKNOWN'): no se sabe cuál fue el propio y cuál de un paciente. Un hito DESCONOCIDO no se afirma ni se niega; si decide la acción, lo correcto es pedir que se clasifiquen.${
        ctx.payments_count > 0
          ? ` Ledger: ${ctx.payments_count} pago(s) (1º ${f(ctx.first_payment_at)}), sin caso asociado.`
          : ""
      }`
    );
  }
  return out;
}

/** Distinción comercialmente crítica: "hace 90 días que nadie lo contacta" y
 *  "no sabemos si alguien lo contactó" llevan a acciones OPUESTAS. Con calidad
 *  de dato POOR el bloque no puede imprimir un reloj de silencio. */
function contactLine(ctx: DoctorContext): string {
  const f = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
  const total = ctx.engagement_classified_count + ctx.engagement_unknown_count;
  const cola = ` · último registro de cualquier tipo: ${f(ctx.last_touch)}`;

  if (ctx.interaction_data_quality === "POOR") {
    const porque =
      total === 0
        ? "no hay NINGUNA actividad registrada"
        : `${ctx.engagement_classified_count} de ${total} actividades tienen engagement_quality clasificada (las cargadas son notas de importación, sin cuerpo del mensaje)`;
    return (
      `- Contacto significativo: NO SE PUEDE DETERMINAR (dato POOR): ${porque}. ` +
      `Esto NO es "nadie lo contactó", es "no sabemos": prohibido usarlo como evidencia de abandono o de silencio.${cola}`
    );
  }
  const caveat =
    ctx.interaction_data_quality === "PARTIAL"
      ? ` · dato PARCIAL (${ctx.engagement_classified_count}/${total} clasificadas): puede haber contactos sin registrar`
      : "";
  if (ctx.last_meaningful_contact) {
    return (
      `- Contacto significativo (activities.engagement_quality='MEANINGFUL'): hace ${
        ctx.days_since_meaningful_contact ?? "—"
      } días (${f(ctx.last_meaningful_contact)})${caveat}${cola}`
    );
  }
  return `- Contacto significativo: ninguno registrado entre las actividades clasificadas${caveat}${cola}`;
}

/** Render compacto es-MX del contexto (~60-90 líneas máx) para el system/user
 *  prompt del agente. No vuelca arrays crudos: top 5-10 items por sección. */
export function contextToPromptBlock(ctx: DoctorContext): string {
  const dias = (n: number | null): string => (n == null ? "—" : `${n} días`);
  const fecha = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—");
  const L: string[] = [];

  L.push(`## Doctor: ${ctx.name} (id ${ctx.doctor_id})`);
  L.push(
    `- Ubicación: ${[ctx.city, ctx.zona, ctx.clinic].filter(Boolean).join(" · ") || "—"}`
  );
  L.push(
    // El owner clínico se declara SIEMPRE, también cuando falta: el Brain manda
    // derivar al clinical_owner del doctor, así que su ausencia es información
    // (corresponde decir "el equipo clínico" y proponer la asignación).
    `- Owner: ${ctx.owner ?? "sin owner"} · Owner clínico: ${ctx.clinical_owner ?? "SIN ASIGNAR (derivar al equipo clínico y proponer asignarlo)"}`
  );
  L.push(
    `- Universo: ${ctx.is_accredited ? "B (acreditado — generar casos)" : "A (NO acreditado — lograr acreditación)"} · Lifecycle: ${ctx.lifecycle} · Categoría: ${ctx.categoria}`
  );
  if (ctx.acquisition_stage)
    L.push(`- Etapa de adquisición: ${ctx.acquisition_stage}`);
  if (ctx.activation_stage) L.push(`- Etapa de activación: ${ctx.activation_stage}`);
  L.push(
    `- Acreditación: ${ctx.accreditation_status}${
      ctx.accreditation_date
        ? ` (${fecha(ctx.accreditation_date)}, hace ${dias(ctx.days_since_accreditation)})`
        : ""
    }`
  );
  if (ctx.is_accredited) {
    L.push(...milestoneLines(ctx));
  }
  L.push(
    `- Casos nuevos: ${ctx.cases_total} históricos · ${ctx.cases_30d} en 30d · ${ctx.cases_90d} en 90d · ${ctx.open_cases} en producción`
  );
  const freq = ctx.historical_case_frequency;
  L.push(
    `- Último caso nuevo: hace ${dias(ctx.days_since_last_case)} · ritmo: ${
      freq.avg_interval_days != null
        ? `cada ~${Math.round(freq.avg_interval_days)} días (${freq.confidence})`
        : `sin ritmo calculado (${freq.confidence})`
    }${freq.expected_next_case_at ? ` · próximo esperado: ${fecha(freq.expected_next_case_at)}` : ""}`
  );
  L.push(contactLine(ctx));
  L.push(
    `- Scores: health ${ctx.health.score ?? "—"}${ctx.health.confidence ? ` (${ctx.health.confidence})` : ""} · prioridad ${ctx.priority.score ?? "—"}${ctx.priority.bucket ? ` (${ctx.priority.bucket})` : ""} · potencial ${ctx.potential_score ?? "—"}`
  );
  if (ctx.priority.reasons.length) {
    L.push(
      `- Razones de prioridad: ${ctx.priority.reasons
        .slice(0, 3)
        .map((r) => r.text)
        .join(" · ")}`
    );
  }
  if (ctx.next_action)
    L.push(`- Próxima acción (motor determinístico): ${ctx.next_action.label}`);
  // Qué canales HAY, no cuáles son: los números no viajan al modelo (lib/ai/pii.ts).
  // El agente necesita esto para no proponer un WhatsApp a quien no tiene WhatsApp.
  const canales = [ctx.has_phone ? "teléfono" : null, ctx.has_whatsapp ? "WhatsApp" : null]
    .filter(Boolean)
    .join(" · ");
  L.push(
    `- Canales disponibles: ${canales || "ninguno cargado — no propongas contacto directo"}` +
      " (el número lo agrega el CRM al enviar; no forma parte de este contexto)"
  );
  if (ctx.wa_channel) {
    L.push(
      `- Chat de WhatsApp: abierto${
        ctx.wa_channel.unanswered ? " · ESPERANDO RESPUESTA (el doctor habló último)" : ""
      }${ctx.wa_channel.activity_bucket ? ` · actividad ${ctx.wa_channel.activity_bucket}` : ""}`
    );
  }
  if (ctx.competitors.length) L.push(`- Competidores: ${ctx.competitors.join(", ")}`);
  if (ctx.lead_source) L.push(`- Fuente: ${ctx.lead_source}`);
  L.push(
    `- Confianza clínica: ${ctx.clinical_confidence}${
      ctx.aligner_experience
        ? ` · experiencia con alineadores: ${truncate(ctx.aligner_experience, 80)}`
        : ""
    }`
  );
  if (ctx.main_objection)
    L.push(`- Objeción/preocupación principal: ${truncate(ctx.main_objection, 160)}`);
  if (ctx.relationship_summary)
    L.push(`- Relación: ${truncate(ctx.relationship_summary, 200)}`);
  if (ctx.kos_status) L.push(`- KOS: ${ctx.kos_status}`);

  if (ctx.service_issues.length) {
    L.push(`### Servicio — ${ctx.service_summary}`);
    // ya ordenados por trust_risk_score desc
    for (const i of ctx.service_issues.slice(0, 5)) {
      L.push(
        `- [${i.severity}·${i.confidence}·${i.trust_risk_score}/100·${
          i.source === "alerta_revisada" ? "revisado" : "estimado"
        }] ${truncate(i.detail, 110)}${i.since ? ` (desde ${fecha(i.since)})` : ""}${
          i.impact_factors.length ? ` — ${i.impact_factors.join("; ")}` : ""
        }`
      );
    }
    L.push(
      `- Impacto: CONFIRMED = lo revisó una persona; LIKELY = fechas duras del sistema; POSSIBLE = estimación (puede ser un hueco de datos). No presentes lo estimado como hecho.`
    );
  } else {
    L.push(`- Servicio: ${ctx.service_summary}`);
  }
  if (ctx.open_opportunities.length) {
    L.push(`### Oportunidades abiertas (${ctx.open_opportunities.length})`);
    for (const o of ctx.open_opportunities.slice(0, 5)) {
      L.push(
        // Referencia, no nombre. La interfaz la resuelve al paciente real.
        `- ${o.ref} · ${o.stage} · ${o.days_in_stage}d en etapa${
          o.probability != null ? ` · ${o.probability}%` : ""
        }`
      );
    }
  }
  if (ctx.tasks.length) {
    L.push(`### Tareas pendientes (${ctx.tasks.length})`);
    for (const t of ctx.tasks.slice(0, 5)) {
      L.push(
        `- ${truncate(t.title, 90)}${
          t.due_date ? ` (vence ${t.due_date}${t.overdue ? ", VENCIDA" : ""})` : ""
        }${t.from_automation ? " [auto]" : ""}`
      );
    }
  }
  if (ctx.recent_activity.length) {
    L.push(`### Actividad reciente (* = MEANINGFUL, ? = sin clasificar)`);
    for (const a of ctx.recent_activity.slice(0, 8)) {
      const mark =
        a.engagement_quality === "MEANINGFUL"
          ? "*"
          : a.engagement_quality === "UNKNOWN"
            ? "?"
            : "";
      L.push(
        `- [${fecha(a.date)}] ${a.type}${mark}${
          a.summary ? `: ${truncate(a.summary, 90)}` : ""
        }`
      );
    }
  }
  if (ctx.notes_summary) {
    L.push(`### Notas recientes`);
    L.push(ctx.notes_summary);
  }
  if (ctx.training_history.length || ctx.keepday_history.length) {
    L.push(`### Capacitación y clínica`);
    for (const t of ctx.training_history.slice(0, 5)) L.push(`- Revisión clínica ${t}`);
    for (const k of ctx.keepday_history.slice(0, 5)) L.push(`- KeepDay ${k}`);
  }
  if (ctx.known_commitments.length) {
    L.push(`### Compromisos conocidos`);
    for (const c of ctx.known_commitments.slice(0, 5)) L.push(`- ${truncate(c, 100)}`);
  }
  if (ctx.open_recommendations.length) {
    L.push(
      `- Recomendaciones AI ya abiertas: ${ctx.open_recommendations.length} (${[
        ...new Set(ctx.open_recommendations.map((r) => r.recommendation_type)),
      ].join(", ")}) — no duplicar`
    );
  }
  L.push(
    `- Datos al: ${ctx.data_as_of} (snapshot de imports; si tiene más de 7 días, degradar confianza y decirlo)`
  );

  return L.join("\n");
}

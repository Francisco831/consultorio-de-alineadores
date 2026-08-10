"use server";

// Calidad de datos — las tres decisiones que la capa AI NO puede tomar sola.
//
// Regla del módulo (migración 0022): nada se infiere. Un caso queda UNKNOWN
// hasta que una persona dice de quién es; una interacción queda UNKNOWN hasta
// que alguien dice si hubo conversación real; una alerta no vale como problema
// de servicio hasta que alguien califica el impacto.
//
// Las tres acciones escriben con el cliente de sesión (RLS + atribución humana):
//  * cases: la policy `cases_update_subject` + guard `cases_subject_guard`
//    (migración 0024) dejan tocar SOLO las cuatro columnas case_subject_* y
//    exigen que la procedencia sea 'humano' y el autor, el usuario logueado.
//  * activities: ya tenía UPDATE para no-VIEWER (0004); 0024 agrega el guard de
//    procedencia.
//  * alerts: UPDATE ya existía (0004) y 0022 amplió `alerts_guard` a las
//    columnas de impacto.
// VIEWER no puede clasificar: se corta acá y RLS lo vuelve a cortar abajo.
//
// Devuelven void para poder colgarse directo del `action` de un <form> en un
// Server Component. Si la escritura falla, la fila NO desaparece de la cola de
// revisión (se ve el error en el server log y el pendiente sigue pendiente).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const SUBJECT_TYPES = ["PATIENT", "DOCTOR_SELF", "OTHER", "UNKNOWN"];
const ENGAGEMENT_QUALITIES = ["MEANINGFUL", "LOW_TOUCH", "UNKNOWN"];
const SERVICE_CONFIDENCES = ["CONFIRMED", "LIKELY", "POSSIBLE"];
// factores documentados en el comment de alerts.impact_factors (0022)
const IMPACT_FACTORS = [
  "dias_atraso",
  "sla_incumplido",
  "queja_registrada",
  "problema_repetido",
  "caso_bloqueado",
  "pedido_sin_responder",
  "paciente_afectado",
  "problema_administrativo",
  "problema_clinico",
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sesión + rol. Sin sesión o con rol VIEWER no se clasifica nada. */
async function sessionWithWriteRole() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, denied: "Sesión expirada" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single();
  const rol = (profile?.rol ?? null) as string | null;
  if (!rol || rol === "VIEWER") {
    return { supabase, user: null, denied: "Tu rol no puede clasificar datos" };
  }
  return { supabase, user, denied: null };
}

function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** De quién es este caso: del paciente, del propio doctor, de otro, o no se sabe.
 *  UNKNOWN es una respuesta válida — "no sé" se registra igual que las demás. */
export async function classifyCaseSubject(formData: FormData): Promise<void> {
  const caseId = field(formData, "case_id");
  const subjectType = field(formData, "case_subject_type");
  if (!UUID_RE.test(caseId) || !SUBJECT_TYPES.includes(subjectType)) {
    console.error("calidad: clasificación de caso inválida", { caseId, subjectType });
    return;
  }

  const { supabase, user, denied } = await sessionWithWriteRole();
  if (!user) {
    console.error("calidad: no se clasificó el caso —", denied);
    return;
  }

  const { data, error } = await supabase
    .from("cases")
    .update({
      case_subject_type: subjectType,
      case_subject_source: "humano",
      case_subject_set_by: user.id,
      case_subject_set_at: new Date().toISOString(),
    })
    .eq("id", caseId)
    .select("id, doctor_id");

  if (error || !data?.length) {
    console.error(
      "calidad: no se clasificó el caso —",
      error?.message ?? "0 filas (rol sin permisos o caso inexistente)"
    );
    return;
  }

  revalidatePath("/calidad");
  revalidatePath(`/doctores/${data[0].doctor_id}`);
}

/** ¿Hubo conversación real o fue un toque? El tipo de actividad no alcanza:
 *  una llamada puede ser "te llamo la semana que viene" y un WhatsApp puede ser
 *  la discusión completa de un caso. Solo lo sabe quien estuvo. */
export async function classifyActivity(formData: FormData): Promise<void> {
  const activityId = field(formData, "activity_id");
  const quality = field(formData, "engagement_quality");
  if (!UUID_RE.test(activityId) || !ENGAGEMENT_QUALITIES.includes(quality)) {
    console.error("calidad: clasificación de interacción inválida", {
      activityId,
      quality,
    });
    return;
  }

  const { supabase, user, denied } = await sessionWithWriteRole();
  if (!user) {
    console.error("calidad: no se clasificó la interacción —", denied);
    return;
  }

  const mainTopic = field(formData, "main_topic");
  const nextAction = field(formData, "next_action");
  const patch: Record<string, unknown> = {
    engagement_quality: quality,
    engagement_source: "humano",
    engagement_set_by: user.id,
    engagement_set_at: new Date().toISOString(),
  };
  // opcionales: si vienen vacíos no se pisa lo que ya haya cargado
  if (mainTopic) patch.main_topic = mainTopic;
  if (nextAction) patch.next_action = nextAction;

  const { data, error } = await supabase
    .from("activities")
    .update(patch)
    .eq("id", activityId)
    .select("id, doctor_id");

  if (error || !data?.length) {
    console.error(
      "calidad: no se clasificó la interacción —",
      error?.message ?? "0 filas (rol sin permisos o actividad inexistente)"
    );
    return;
  }

  revalidatePath("/calidad");
  revalidatePath(`/doctores/${data[0].doctor_id}`);
}

/** ¿Esta alerta puede dañar de verdad la confianza del doctor? La pregunta no
 *  es "¿hay una alerta?". Sin esta revisión, la capa AI trata el impacto como
 *  estimación y lo declara como tal. */
export async function reviewServiceAlert(formData: FormData): Promise<void> {
  const alertId = field(formData, "alert_id");
  const confidence = field(formData, "service_confidence");
  if (!UUID_RE.test(alertId) || !SERVICE_CONFIDENCES.includes(confidence)) {
    console.error("calidad: revisión de alerta inválida", { alertId, confidence });
    return;
  }

  const riskRaw = field(formData, "trust_risk_score");
  const risk = riskRaw === "" ? null : Number(riskRaw);
  if (risk != null && (!Number.isInteger(risk) || risk < 0 || risk > 100)) {
    console.error("calidad: riesgo de confianza fuera de rango", riskRaw);
    return;
  }

  const factors = formData
    .getAll("impact_factors")
    .map((f) => String(f))
    .filter((f) => IMPACT_FACTORS.includes(f));

  const { supabase, user, denied } = await sessionWithWriteRole();
  if (!user) {
    console.error("calidad: no se revisó la alerta —", denied);
    return;
  }

  const { data, error } = await supabase
    .from("alerts")
    .update({
      service_confidence: confidence,
      trust_risk_score: risk,
      impact_factors: factors,
    })
    .eq("id", alertId)
    .select("id, doctor_id");

  if (error || !data?.length) {
    console.error(
      "calidad: no se revisó la alerta —",
      error?.message ?? "0 filas (rol sin permisos o alerta inexistente)"
    );
    return;
  }

  revalidatePath("/calidad");
  revalidatePath("/hoy");
  if (data[0].doctor_id) revalidatePath(`/doctores/${data[0].doctor_id}`);
}

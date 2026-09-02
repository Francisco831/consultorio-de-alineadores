import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Actividad humana del CRM, unificada: las cinco fuentes que llevan autor
 * (actividades, tareas creadas/completadas, oportunidades, eventos y las
 * ediciones del audit_log). Compartida por la vista diaria y el calendario.
 * El sync/cron entra sin sesión (actor null) y queda afuera solo.
 */

export const MX_OFFSET = "-06:00"; // CDMX es UTC-6 fijo (sin horario de verano desde 2022)
export const MX_TZ = "America/Mexico_City";

export const ACT_LABEL: Record<string, string> = {
  llamada: "Llamada",
  videollamada: "Videollamada",
  whatsapp: "WhatsApp",
  visita: "Visita",
  reunion: "Reunión",
  revision_clinica: "Revisión clínica",
  email: "Email",
  nota: "Nota",
  keepday: "KeepDay",
  seguimiento: "Seguimiento",
};

/** tipos de actividad que cuentan como "hablé con alguien" */
export const CONTACTO_TYPES = new Set([
  "llamada",
  "videollamada",
  "whatsapp",
  "visita",
  "reunion",
  "keepday",
]);

const FIELD_LABEL: Record<string, string> = {
  lifecycle_stage: "etapa",
  acquisition_stage: "etapa de captación",
  activation_stage: "etapa de activación",
  accredited_at: "fecha de acreditación",
  owner_id: "responsable",
  categoria: "categoría",
  potential_override: "potencial",
  stage: "etapa",
  forecast_category: "forecast",
  status: "estado",
  // el texto de una nota de la ficha (0051); así se llaman en el diálogo
  summary: "resumen",
  outcome: "resultado",
};

export type DocRef = { id: string; nombre: string } | null;

export type ItemActividad = {
  ts: string;
  actor: string | null;
  kind: "actividad" | "tarea" | "tarea_ok" | "oportunidad" | "evento" | "edicion";
  badge: string;
  text: string;
  doctor: DocRef;
  /**
   * Si el renglón suma al número de cargas del día de esa persona. Falso solo
   * para las correcciones de texto: arreglar un typo no es una carga más.
   */
  cuentaEnElDia: boolean;
  esContacto: boolean;
};

export type PerfilEquipo = {
  id: string;
  nombre: string;
  rol: string;
  activo: boolean;
};

const docDe = (rel: unknown): DocRef => {
  const r = rel as { id?: string; nombre?: string } | null;
  return r?.id && r?.nombre ? { id: r.id, nombre: r.nombre } : null;
};

/** YYYY-MM-DD del timestamp, visto desde México */
export function diaMX(ts: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MX_TZ }).format(new Date(ts));
}

export async function fetchActividad(
  supabase: SupabaseClient,
  desde: string,
  hasta: string
): Promise<{ items: ItemActividad[]; profiles: PerfilEquipo[] }> {
  const [
    { data: profiles },
    { data: acts },
    { data: tareasNuevas },
    { data: tareasHechas },
    { data: opps },
    { data: eventos },
    { data: audit },
  ] = await Promise.all([
    supabase.from("profiles").select("id, nombre, rol, activo").order("nombre"),
    supabase
      .from("activities")
      .select("type, summary, outcome, occurred_at, created_by, doctors(id, nombre)")
      .eq("is_demo", false)
      .not("created_by", "is", null)
      .gte("occurred_at", desde)
      .lt("occurred_at", hasta),
    supabase
      .from("tasks")
      .select("title, type, created_at, created_by, assigned_to, doctors(id, nombre)")
      .eq("is_demo", false)
      .not("created_by", "is", null)
      .gte("created_at", desde)
      .lt("created_at", hasta),
    supabase
      .from("tasks")
      .select("title, type, completed_at, created_by, assigned_to, doctors(id, nombre)")
      .eq("is_demo", false)
      .gte("completed_at", desde)
      .lt("completed_at", hasta),
    supabase
      .from("opportunities")
      .select("patient_name, created_at, owner_id, doctors(id, nombre)")
      .eq("is_demo", false)
      .not("owner_id", "is", null)
      .gte("created_at", desde)
      .lt("created_at", hasta),
    supabase
      .from("events")
      .select("titulo, tipo, fecha, created_at, created_by, event_attendees(id)")
      .not("created_by", "is", null)
      .gte("created_at", desde)
      .lt("created_at", hasta),
    supabase
      .from("audit_log")
      .select("entity_type, entity_id, field, old_value, new_value, actor_id, created_at")
      .eq("source", "app")
      .not("actor_id", "is", null)
      .gte("created_at", desde)
      .lt("created_at", hasta),
  ]);

  const nombreDe = new Map((profiles ?? []).map((p) => [p.id, p.nombre]));

  // el audit guarda solo ids: resolver a qué doctor/oportunidad/tarea pertenece cada edición
  const idsPor = (tipo: string) =>
    [...new Set((audit ?? []).filter((a) => a.entity_type === tipo).map((a) => a.entity_id))];
  const [docIds, oppIds, taskIds, actIds] = [
    idsPor("doctor"),
    idsPor("opportunity"),
    idsPor("task"),
    idsPor("activity"),
  ];
  const [{ data: auditDocs }, { data: auditOpps }, { data: auditTasks }, { data: auditActs }] =
    await Promise.all([
      docIds.length
        ? supabase.from("doctors").select("id, nombre").in("id", docIds)
        : Promise.resolve({ data: [] }),
      oppIds.length
        ? supabase.from("opportunities").select("id, doctors(id, nombre)").in("id", oppIds)
        : Promise.resolve({ data: [] }),
      taskIds.length
        ? supabase.from("tasks").select("id, title, doctors(id, nombre)").in("id", taskIds)
        : Promise.resolve({ data: [] }),
      // el audit de una nota guarda el id de la ACTIVIDAD: sin esta vuelta el
      // renglón no linkea a la ficha, que es la única razón por la que Pancho
      // hace click en esta pantalla. Es una consulta más solo los días en que
      // alguien corrigió algo.
      actIds.length
        ? supabase.from("activities").select("id, doctors(id, nombre)").in("id", actIds)
        : Promise.resolve({ data: [] }),
    ]);
  const auditDoc = new Map((auditDocs ?? []).map((x) => [x.id, x]));
  const auditOpp = new Map((auditOpps ?? []).map((x) => [x.id, x]));
  const auditTask = new Map((auditTasks ?? []).map((x) => [x.id, x]));
  const auditAct = new Map((auditActs ?? []).map((x) => [x.id, x]));

  const prettyVal = (field: string, v: string | null): string => {
    if (!v) return "—";
    if (field === "owner_id") return nombreDe.get(v) ?? "otro";
    if (field === "accredited_at") return v.slice(0, 10);
    return v.replace(/_/g, " ");
  };

  /** un renglón del feed tiene que seguir siendo un renglón */
  const recorte = (v: string | null): string => {
    const t = (v ?? "").replace(/\s+/g, " ").trim();
    return t.length > 80 ? `${t.slice(0, 80).trimEnd()}…` : t;
  };

  const items: ItemActividad[] = [];
  for (const a of acts ?? [])
    items.push({
      ts: a.occurred_at,
      actor: a.created_by,
      kind: "actividad",
      badge: ACT_LABEL[a.type] ?? a.type,
      text: [a.summary, a.outcome].filter(Boolean).join(" — ") || "(sin detalle)",
      doctor: docDe(a.doctors),
      cuentaEnElDia: true,
      esContacto: CONTACTO_TYPES.has(a.type),
    });
  for (const t of tareasNuevas ?? [])
    items.push({
      ts: t.created_at,
      actor: t.created_by,
      kind: "tarea",
      badge: "Tarea nueva",
      text:
        `«${t.title}»` +
        (t.assigned_to && t.assigned_to !== t.created_by
          ? ` para ${nombreDe.get(t.assigned_to) ?? "otro"}`
          : ""),
      doctor: docDe(t.doctors),
      cuentaEnElDia: true,
      esContacto: false,
    });
  for (const t of tareasHechas ?? [])
    items.push({
      ts: t.completed_at!,
      actor: t.assigned_to ?? t.created_by,
      kind: "tarea_ok",
      badge: "Tarea completada",
      text: `«${t.title}»`,
      doctor: docDe(t.doctors),
      cuentaEnElDia: true,
      esContacto: false,
    });
  for (const o of opps ?? [])
    items.push({
      ts: o.created_at,
      actor: o.owner_id,
      kind: "oportunidad",
      badge: "Oportunidad",
      text: `Nueva oportunidad${o.patient_name ? ` — paciente ${o.patient_name}` : ""}`,
      doctor: docDe(o.doctors),
      cuentaEnElDia: true,
      esContacto: false,
    });
  for (const e of eventos ?? [])
    items.push({
      ts: e.created_at,
      actor: e.created_by,
      kind: "evento",
      badge: "Evento",
      text: `${e.titulo} (${e.tipo}, ${(e.event_attendees ?? []).length} asistentes)`,
      doctor: null,
      cuentaEnElDia: true,
      esContacto: false,
    });
  for (const a of audit ?? []) {
    // completar una tarea ya aparece como "Tarea completada": no duplicar
    if (a.entity_type === "task" && a.field === "status" && a.new_value === "completada")
      continue;
    const campo = FIELD_LABEL[a.field] ?? a.field;

    // Corregir el texto de una nota (0051) no entra en el molde de abajo
    // ("cambió X: viejo → nuevo"): ese molde es para enums de una palabra y una
    // nota tiene hasta 2.000 caracteres, así que volcaría el texto entero —el
    // viejo Y el nuevo— en un feed de renglones cortos, y encima pasado por
    // prettyVal, que le comería los guiones bajos. Para lo que sirve esta
    // pantalla —qué hizo cada uno en el día— alcanza con quién corrigió qué y
    // cómo quedó la nota; lo que decía antes queda entero en audit_log, que es
    // exactamente para eso.
    if (a.entity_type === "activity") {
      const ahora = recorte(a.new_value);
      items.push({
        ts: a.created_at,
        actor: a.actor_id,
        kind: "edicion",
        badge: "Corrección",
        text: ahora
          ? `corrigió el ${campo} de una nota: «${ahora}»`
          : `dejó una nota sin ${campo}`,
        doctor: docDe(auditAct.get(a.entity_id)?.doctors),
        // Corregir un typo no es una carga del día: si contara, a Rocío le
        // sumaría igual que una llamada. `actor: null` la sacaría sola de los
        // conteos sin tocar ninguna pantalla, pero también la borraría del
        // filtro por persona y del "Rocío:" del renglón — mentira más grande
        // que el +1. Por eso la marca es explícita: los totales por persona de
        // /equipo/actividad y de su calendario tienen que saltear los items
        // con cuentaEnElDia en false.
        cuentaEnElDia: false,
        esContacto: false,
      });
      continue;
    }

    let doctor: DocRef = null;
    let sujeto = "";
    if (a.entity_type === "doctor") {
      doctor = auditDoc.get(a.entity_id) ?? null;
    } else if (a.entity_type === "opportunity") {
      doctor = docDe(auditOpp.get(a.entity_id)?.doctors);
      sujeto = "en la oportunidad, ";
    } else if (a.entity_type === "task") {
      const t = auditTask.get(a.entity_id);
      doctor = docDe(t?.doctors);
      sujeto = t ? `en la tarea «${t.title}», ` : "en una tarea, ";
    } else {
      sujeto = `en ${a.entity_type}, `;
    }
    items.push({
      ts: a.created_at,
      actor: a.actor_id,
      kind: "edicion",
      badge: "Edición",
      text: `${sujeto}cambió ${campo}: ${prettyVal(a.field, a.old_value)} → ${prettyVal(
        a.field,
        a.new_value
      )}`,
      doctor,
      cuentaEnElDia: true,
      esContacto: false,
    });
  }

  items.sort((a, b) => b.ts.localeCompare(a.ts));
  return { items, profiles: (profiles ?? []) as PerfilEquipo[] };
}

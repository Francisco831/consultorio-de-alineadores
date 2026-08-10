// Tools de BORRADOR — NO escriben nada en ninguna tabla. Validan los argumentos
// y devuelven el draft estructurado que el agente debe incorporar a su
// recomendación (emit): payload para task/activity/profile_update, o
// suggested_message para mensajes. La ejecución real ocurre solo cuando el
// usuario acepta la recomendación (HITL, contrato P34: Juan da el click final).

import { z } from "zod";
import { TASK_TYPES, toStrictJsonSchema } from "@/lib/ai/schemas";
import { complete, withMeta } from "@/lib/ai/completeness";
import type { AiToolDef, AiToolResult } from "@/lib/ai/types";

// Envoltorio { data, meta } igual que las tools de lectura, para que el agente
// no tenga que tratar dos formas distintas de respuesta. Un borrador no consulta
// la base: no hay filas consideradas y no hay nada incompleto que declarar.
const DRAFT_SOURCE = "validación en memoria (el borrador no consulta la base)";

const ACTIVITY_TYPES = [
  "llamada",
  "whatsapp",
  "visita",
  "reunion",
  "revision_clinica",
  "email",
  "nota",
  "keepday",
] as const;

const PROFILE_FIELDS = [
  "experience_with_aligners",
  "clinical_confidence",
  "main_concerns",
  "preferred_contact_style",
  "business_goals",
  "growth_ambition",
  "known_objections",
  "competitor_relationship",
  "previous_bad_experiences",
  "relationship_notes",
  "team_readiness",
  "patient_acquisition_problem",
  "education_needs",
] as const;

const CONFIDENCE_VALUES = new Set(["alta", "media", "baja", "desconocida"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function defineDraftTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.output<S>) => AiToolResult;
}): AiToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: toStrictJsonSchema(def.schema),
    handler: async (args) => def.handler(def.schema.parse(args)),
  };
}

const PAYLOAD_NOTE =
  "Borrador validado. NO se ejecutó nada: incluir este draft tal cual en el campo `payload` de la recomendación emitida (emit). Se ejecuta solo si el usuario la acepta.";

export const createTaskDraft = defineDraftTool({
  name: "createTaskDraft",
  description:
    "Valida y estructura el BORRADOR de una tarea (llamada, visita, seguimiento, etc.) sin crearla. Usala cuando tu recomendación implica agendar una acción concreta: el draft devuelto va en el campo `payload` (kind 'task') de la recomendación; la tarea se crea recién cuando el usuario acepta.",
  schema: z.strictObject({
    title: z.string().describe("título corto y accionable de la tarea, es-MX"),
    type: z.enum(TASK_TYPES).describe("tipo de tarea"),
    due_date: z
      .string()
      .nullish()
      .describe("fecha límite YYYY-MM-DD; omitir o null si no aplica"),
    description: z
      .string()
      .nullish()
      .describe("detalle/contexto; se puede omitir"),
  }),
  handler: ({ title, type, due_date, description }) => {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("title no puede estar vacío");
    if (due_date != null && !DATE_RE.test(due_date))
      throw new Error("due_date debe ser YYYY-MM-DD o null");
    return {
      data: withMeta(
        {
          draft: {
            kind: "task" as const,
            title: trimmed,
            type,
            due_date,
            description: description?.trim() || null,
          },
          instrucciones: PAYLOAD_NOTE,
        },
        complete(0, DRAFT_SOURCE)
      ),
      rows: null,
    };
  },
});

export const createMessageDraft = defineDraftTool({
  name: "createMessageDraft",
  description:
    "Valida el BORRADOR de un mensaje para el doctor (WhatsApp o email) sin enviarlo — no existe API de envío y el envío SIEMPRE lo hace un humano. Usala para redactar el texto sugerido: el mensaje devuelto va en `suggested_message` de la recomendación. Tono usted, cercano, nunca venta abierta.",
  schema: z.strictObject({
    channel: z.enum(["whatsapp", "email"]).describe("canal del mensaje"),
    message: z.string().describe("texto completo del mensaje, es-MX, tono usted"),
  }),
  handler: ({ channel, message }) => {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("message no puede estar vacío");
    return {
      data: withMeta(
        {
          draft: { channel, message: trimmed },
          instrucciones:
            "Borrador validado. NO se envió nada: incluir el texto en `suggested_message` de la recomendación emitida (emit). El envío siempre lo hace un humano desde WhatsApp/Periskope.",
        },
        complete(0, DRAFT_SOURCE)
      ),
      rows: null,
    };
  },
});

export const createActivityDraft = defineDraftTool({
  name: "createActivityDraft",
  description:
    "Valida y estructura el BORRADOR de una actividad a registrar (por ejemplo una nota o el registro de una interacción ya ocurrida) sin escribirla. El draft devuelto va en el campo `payload` (kind 'activity') de la recomendación; se registra recién cuando el usuario acepta.",
  schema: z.strictObject({
    type: z.enum(ACTIVITY_TYPES).describe("tipo de actividad"),
    summary: z.string().describe("resumen de la actividad, es-MX"),
    outcome: z
      .string()
      .nullish()
      .describe("resultado/outcome; se puede omitir"),
  }),
  handler: ({ type, summary, outcome }) => {
    const trimmed = summary.trim();
    if (!trimmed) throw new Error("summary no puede estar vacío");
    return {
      data: withMeta(
        {
          draft: {
            kind: "activity" as const,
            type,
            summary: trimmed,
            outcome: outcome?.trim() || null,
          },
          instrucciones: PAYLOAD_NOTE,
        },
        complete(0, DRAFT_SOURCE)
      ),
      rows: null,
    };
  },
});

export const proposeDoctorUpdate = defineDraftTool({
  name: "proposeDoctorUpdate",
  description:
    "Valida el BORRADOR de una actualización del perfil AI del doctor (doctor_ai_profile: confianza clínica, objeciones, metas, relación, etc.) sin escribir nada. El perfil solo se actualiza por input humano o cuando el usuario acepta la recomendación (recommendation_type 'profile_update'): el draft va en `payload` (kind 'profile_update').",
  schema: z.strictObject({
    fields: z
      .record(z.string(), z.string().nullable())
      .describe(
        `campos a actualizar; claves válidas: ${PROFILE_FIELDS.join(", ")}`
      ),
    rationale: z
      .string()
      .describe("por qué se propone el cambio, citando la evidencia observada"),
  }),
  handler: ({ fields, rationale }) => {
    const keys = Object.keys(fields);
    if (keys.length === 0) throw new Error("fields no puede estar vacío");
    const valid = new Set<string>(PROFILE_FIELDS);
    for (const k of keys) {
      if (!valid.has(k))
        throw new Error(
          `Campo desconocido: ${k}. Campos válidos: ${PROFILE_FIELDS.join(", ")}`
        );
    }
    const conf = fields.clinical_confidence;
    if (conf != null && !CONFIDENCE_VALUES.has(conf))
      throw new Error("clinical_confidence debe ser alta | media | baja | desconocida");
    const trimmedRationale = rationale.trim();
    if (!trimmedRationale) throw new Error("rationale no puede estar vacío");
    return {
      data: withMeta(
        {
          draft: {
            kind: "profile_update" as const,
            fields,
            rationale: trimmedRationale,
          },
          instrucciones: PAYLOAD_NOTE,
        },
        complete(0, DRAFT_SOURCE)
      ),
      rows: null,
    };
  },
});

export const DRAFT_TOOLS: AiToolDef[] = [
  createTaskDraft,
  createMessageDraft,
  createActivityDraft,
  proposeDoctorUpdate,
];

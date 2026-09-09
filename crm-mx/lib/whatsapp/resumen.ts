// El resumen de un día de WhatsApp con un doctor, hecho por el modelo.
//
// Una llamada por (chat, día). Devuelve JSON validado con zod (output
// estructurado): resumen de dos oraciones, si el último mensaje pide respuesta
// nuestra, y los pedidos concretos del doctor que ameritan una tarea. El CRM
// NO ejecuta nada de esto solo: el resumen va a una actividad y los pedidos
// quedan como propuestas (ai_recommendations, HITL) hasta que alguien las acepte.
//
// Al modelo no le llegan teléfonos ni el nombre del chat (lib/ai/pii.ts): la
// transcripción ya sale sin números y el nombre del doctor es la única persona
// nombrada. Los pacientes que aparezcan en los mensajes se piden como "una
// paciente", nunca por nombre.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AI_MODEL } from "@/lib/ai/db";
import { estimateCostUsd } from "@/lib/ai/cost";

export const TIPOS_TAREA = [
  "seguimiento",
  "llamada",
  "videollamada",
  "whatsapp",
  "revision_clinica",
  "reunion",
  "visita",
] as const;

export const resumenSchema = z.object({
  /** Dos oraciones como máximo, castellano neutro, sin nombres de pacientes. */
  resumen: z.string(),
  /** ¿El último mensaje del doctor pide algo que KS todavía no contestó? */
  pide_respuesta: z.boolean(),
  /** true si se habló de un caso, viabilidad, precio, problema o pedido; false
   *  si fue solo cortesía, saludo o coordinación trivial. */
  sustantivo: z.boolean(),
  tema: z.string(),
  pedidos: z.array(
    z.object({
      /** ≤ 80 caracteres, empieza con verbo: "Enviar viabilidad de una paciente". */
      titulo: z.string(),
      tipo: z.enum(TIPOS_TAREA),
      /** En cuántos días conviene tenerlo hecho (1 a 14). */
      vence_en_dias: z.number().int().min(1).max(14),
    })
  ),
});

export type Resumen = z.infer<typeof resumenSchema>;

const SYSTEM = `Sos el asistente del CRM de KeepSmiling México (alineadores dentales). Leés la conversación de WhatsApp de UN día entre una línea de KeepSmiling (KS) y un doctor ortodoncista, y devolvés un JSON.

Reglas:
- "resumen": una o dos oraciones, castellano neutro, en pasado, con lo que importa comercial o clínicamente (qué pidió, qué se le contestó, qué quedó pendiente). Sin saludos ni relleno. Nunca escribas el nombre de un paciente: decí "una paciente" / "un paciente".
- "pide_respuesta": true solo si el ÚLTIMO mensaje es del doctor (no de KS) y contiene una pregunta o un pedido que KS todavía no contestó. Un "gracias", "ok" o un sticker final NO piden respuesta.
- "sustantivo": true si se habló de un caso, plan, viabilidad, precio, envío, problema, capacitación o pedido concreto. false si fue solo cortesía o coordinación trivial.
- "pedidos": SOLO lo que el doctor pidió explícitamente y requiere que alguien de KS haga algo después del chat (mandar una viabilidad, revisar un caso, cotizar, llamar, agendar). Si KS ya lo resolvió en el mismo chat, no va. Si no hay nada, lista vacía. Máximo 3.
- "tema": dos a cuatro palabras (ej. "viabilidad caso niño", "reclamo envío", "consulta precio").`;

export interface EntradaResumen {
  doctorNombre: string;
  dia: string; // YYYY-MM-DD
  transcripcion: string;
  /** Contexto de días anteriores, ya resumido, si lo hay. */
  contextoPrevio?: string | null;
}

export interface SalidaResumen {
  resumen: Resumen;
  costo_usd: number;
  modelo: string;
}

let cliente: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!cliente) cliente = new Anthropic();
  return cliente;
}

/** El modelo para los resúmenes. Se puede bajar con WA_AI_MODEL sin tocar la capa AI. */
export const WA_AI_MODEL = process.env.WA_AI_MODEL?.trim() || AI_MODEL;

export async function resumirDia(e: EntradaResumen): Promise<SalidaResumen> {
  const partes = [
    `Doctor: ${e.doctorNombre}`,
    `Día: ${e.dia} (hora de México)`,
    e.contextoPrevio ? `Contexto de días anteriores: ${e.contextoPrevio}` : null,
    `Conversación:\n${e.transcripcion}`,
  ].filter(Boolean);

  const response = await anthropic().messages.parse({
    model: WA_AI_MODEL,
    max_tokens: 2000,
    // Resumir un chat corto no necesita pensar mucho: low baja el costo sin
    // perder calidad en esta tarea. Se mide en costo_usd de cada corrida.
    output_config: { effort: "low", format: zodOutputFormat(resumenSchema) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: partes.join("\n\n") }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`El modelo rechazó resumir el chat (${response.stop_details?.category ?? "sin categoría"})`);
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("El modelo no devolvió el JSON esperado");

  const costo =
    estimateCostUsd({
      model: WA_AI_MODEL,
      input: response.usage.input_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      output: response.usage.output_tokens,
    }) ?? 0;

  return { resumen: parsed, costo_usd: costo, modelo: WA_AI_MODEL };
}

// Director comercial AI (docs/AI_ARCHITECTURE.md §2, §12): solo lo invoca el
// manager — Ask Your CRM (pregunta libre) y AI Morning Brief (instrucción fija).
// Ambos corren el commercial_director vía runDirectorLLM; números SIEMPRE de tools.

import { runDirectorLLM } from "@/lib/ai/runner";
import { todayMX } from "@/lib/dates";
import type { DirectorBrief } from "@/lib/ai/types";

export async function askDirector(
  question: string,
  opts: { requestedBy: string | null }
): Promise<DirectorBrief> {
  const { brief } = await runDirectorLLM({
    trigger: "ask",
    requestedBy: opts.requestedBy,
    doctorId: null,
    userMessage: question,
  });
  return brief;
}

export async function generateMorningBrief(opts: {
  requestedBy: string | null;
}): Promise<{ brief: DirectorBrief; runId: string }> {
  // Formato BREVE a propósito: este brief se lee todas las mañanas desde el
  // celular en un minuto. El análisis profundo de 15 secciones sigue disponible
  // vía Ask Your CRM; acá el detalle viaja en findings/recommendations.
  const userMessage = [
    `Hoy es ${todayMX()}. Genera el brief comercial de la mañana para el Country Manager (es-MX).`,
    "FORMATO BREVE OBLIGATORIO — ignora las 15 secciones del brief profundo.",
    "`answer` tiene 150 palabras como máximo, sin títulos en mayúsculas, con esta estructura:",
    "· Meta del mes en una línea: casos pagados X de Y, acreditaciones X de Y.",
    "· Qué cambió desde el último brief: 1-2 líneas (si nada cambió, una línea que lo diga).",
    "· HOY, máximo 3 acciones: doctor → acción → por qué, una línea cada una.",
    "· Un riesgo o dato faltante, una línea.",
    "El detalle y la evidencia van en findings y recommendations, nunca en answer.",
    "Usa tus tools para traer los números reales — no cites ningún número que no venga de una tool.",
    "Emite recomendaciones con doctor_id cuando la acción sea sobre un doctor específico.",
  ].join("\n");

  return runDirectorLLM({
    trigger: "hoy",
    requestedBy: opts.requestedBy,
    doctorId: null,
    userMessage,
  });
}

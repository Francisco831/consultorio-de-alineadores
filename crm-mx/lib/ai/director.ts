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
  const userMessage = [
    `Hoy es ${todayMX()}. Genera el brief comercial de la mañana para el Country Manager (es-MX).`,
    "Prioridades de HOY, en este orden:",
    "1. Doctores en riesgo o con señales de servicio abiertas.",
    "2. Acreditados sin activar (sin primer caso de paciente pagado).",
    "3. Casos trabados que están frenando confianza.",
    "4. Pipeline y casos pagados del mes vs la meta del mes.",
    "5. Top 3-5 acciones concretas para hoy: qué doctor, qué acción y por qué (con evidencia).",
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

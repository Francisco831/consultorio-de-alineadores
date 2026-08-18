// POST /api/ai/ask — Ask Your CRM: pregunta libre al commercial_director.
// Sesión, rol, clave y tope de gasto: lib/ai/guard.ts (una sola regla para las 3 rutas).

import { NextResponse } from "next/server";
import { requireAgentInvoker, MAX_PREGUNTA_CHARS } from "@/lib/ai/guard";
import { askDirector } from "@/lib/ai/director";

// 300 = el techo del plan Pro de Vercel (contratado el 18/8/2026), y hace falta
// entero: las seis corridas reales medidas el 13/8 tardaron 74, 84, 118, 122, 123
// y 144 segundos (agent_runs.latency_ms). Con el techo de 60 del plan Hobby este
// endpoint se cortaba SIEMPRE — y como el runner escribe agent_runs recién al
// terminar, la corrida moría sin dejar rastro: se pagaba y no se registraba.
// Si el proyecto vuelve a Hobby alguna vez, esto se baja a 60 y se descarga
// ANTHROPIC_API_KEY de Vercel (sin clave el guard responde 503 limpio).
export const maxDuration = 300;

export async function POST(request: Request) {
  const guard = await requireAgentInvoker();
  if (!guard.ok) return guard.res;
  const { user } = guard.invocador;

  let question = "";
  try {
    const body = (await request.json()) as { question?: unknown };
    question = String(body?.question ?? "").trim();
  } catch {
    // body inválido → cae al 400 de abajo
  }
  if (!question) {
    return NextResponse.json({ error: "Falta la pregunta" }, { status: 400 });
  }
  // La pregunta entra entera al prompt: sin cota, un pegado accidental de miles de
  // líneas se paga en tokens y puede tumbar la corrida por tamaño de contexto.
  if (question.length > MAX_PREGUNTA_CHARS) {
    return NextResponse.json(
      {
        error: `La pregunta es demasiado larga (${question.length} caracteres, máximo ${MAX_PREGUNTA_CHARS}).`,
      },
      { status: 400 }
    );
  }

  try {
    const brief = await askDirector(question, { requestedBy: user.id });
    return NextResponse.json(brief);
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error inesperado al responder la pregunta";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/ai/ask — Ask Your CRM: pregunta libre al commercial_director.
// Sesión, rol, clave y tope de gasto: lib/ai/guard.ts (una sola regla para las 3 rutas).

import { NextResponse } from "next/server";
import { requireAgentInvoker, MAX_PREGUNTA_CHARS } from "@/lib/ai/guard";
import { askDirector } from "@/lib/ai/director";

// 60 y no 300 porque el proyecto está en el plan Hobby de Vercel, cuyo techo son
// 60 segundos: declarar más hace fallar el despliegue.
//
// LO QUE HAY QUE SABER: las seis corridas reales medidas el 13/8 tardaron 74, 84,
// 118, 122, 123 y 144 segundos (agent_runs.latency_ms). Las seis pasan de 60, y la
// de 74 es la que corrió con effort 'medium' — bajar el esfuerzo no alcanza. En
// Hobby este endpoint se corta SIEMPRE, y como el runner escribe la fila de
// agent_runs recién cuando el agente termina, la corrida muere antes de dejar
// rastro: se paga y no se registra.
//
// Por eso en Hobby NO se carga ANTHROPIC_API_KEY: sin clave el guard responde 503
// limpio y no se gasta nada. El resto del CRM no depende de esto.
export const maxDuration = 60;

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

// POST /api/ai/analyze — corre el orchestrator sobre un doctor (Doctor 360).
// Sesión, rol, clave y tope de gasto: lib/ai/guard.ts (una sola regla para las 3 rutas).

import { NextResponse } from "next/server";
import { requireAgentInvoker, esUuid } from "@/lib/ai/guard";
import { analyzeDoctor } from "@/lib/ai/orchestrator";

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

  let doctorId = "";
  try {
    const body = (await request.json()) as { doctorId?: unknown };
    doctorId = String(body?.doctorId ?? "").trim();
  } catch {
    // body inválido → cae al 400 de abajo
  }
  if (!doctorId) {
    return NextResponse.json({ error: "Falta doctorId" }, { status: 400 });
  }
  // Se valida acá y no en Postgres: un id con formato inválido volvía como 500 con
  // el mensaje crudo del driver, que no le sirve a nadie y expone el error interno.
  if (!esUuid(doctorId)) {
    return NextResponse.json({ error: "doctorId no es un UUID" }, { status: 400 });
  }

  try {
    const assessment = await analyzeDoctor(doctorId, {
      requestedBy: user.id,
      trigger: "doctor360",
    });
    return NextResponse.json(assessment);
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error inesperado al analizar el doctor";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// /api/ai/brief — AI Morning Brief del commercial_director.
// POST genera uno nuevo (LLM); GET devuelve el último persistido en agent_runs.
//
// Los dos guards son distintos a propósito: el GET no llama al modelo, así que
// pasa por requireSession() y NO cae bajo el tope de gasto — quedarse sin
// presupuesto no puede dejar de mostrar el brief que ya está escrito.

import { NextResponse } from "next/server";
import { requireAgentInvoker, requireSession } from "@/lib/ai/guard";
import { generateMorningBrief } from "@/lib/ai/director";

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

export async function POST() {
  const guard = await requireAgentInvoker();
  if (!guard.ok) return guard.res;

  try {
    const { brief, runId } = await generateMorningBrief({
      requestedBy: guard.invocador.user.id,
    });
    return NextResponse.json({ brief, runId });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error inesperado al generar el brief";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const guard = await requireSession();
  if (!guard.ok) return guard.res;

  const { data, error } = await guard.invocador.supabase
    .from("agent_runs")
    .select("id, result, created_at")
    .eq("agent", "commercial_director")
    .eq("trigger", "hoy")
    .eq("status", "ok")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.result) {
    return NextResponse.json({ brief: null });
  }
  return NextResponse.json({
    brief: data.result,
    runId: data.id,
    created_at: data.created_at,
  });
}

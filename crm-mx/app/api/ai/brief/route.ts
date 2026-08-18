// /api/ai/brief — AI Morning Brief del commercial_director.
// POST genera uno nuevo (LLM); GET devuelve el último persistido en agent_runs.
//
// Los dos guards son distintos a propósito: el GET no llama al modelo, así que
// pasa por requireSession() y NO cae bajo el tope de gasto — quedarse sin
// presupuesto no puede dejar de mostrar el brief que ya está escrito.

import { NextResponse } from "next/server";
import { requireAgentInvoker, requireSession } from "@/lib/ai/guard";
import { generateMorningBrief } from "@/lib/ai/director";

// 300 = el techo del plan Pro de Vercel (contratado el 18/8/2026), y hace falta
// entero: las seis corridas reales medidas el 13/8 tardaron 74, 84, 118, 122, 123
// y 144 segundos (agent_runs.latency_ms). Con el techo de 60 del plan Hobby este
// endpoint se cortaba SIEMPRE — y como el runner escribe agent_runs recién al
// terminar, la corrida moría sin dejar rastro: se pagaba y no se registraba.
// Si el proyecto vuelve a Hobby alguna vez, esto se baja a 60 y se descarga
// ANTHROPIC_API_KEY de Vercel (sin clave el guard responde 503 limpio).
export const maxDuration = 300;

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

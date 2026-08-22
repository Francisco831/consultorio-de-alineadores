// /api/ai/brief/cron — regeneración automática del AI Morning Brief.
//
// La dispara el cron de Vercel (vercel.json, 13:00 UTC = 7:00 CDMX, sin DST
// desde 2022) con `Authorization: Bearer $CRON_SECRET` — el mismo esquema que
// /api/sync/*. También sirve para regenerarlo a mano con curl y ese header.
//
// Corre sin sesión de usuario: requested_by queda null y la corrida se
// registra igual en agent_runs con trigger "hoy", que es lo que el GET de
// /api/ai/brief (y por lo tanto la pantalla Hoy) levanta como último brief.
// Respeta el mismo tope de gasto diario que el POST manual.

import { NextResponse } from "next/server";
import { aiConfigured } from "@/lib/ai/db";
import { AI_DAILY_BUDGET_USD, gastoDeHoyUSD } from "@/lib/ai/guard";
import { generateMorningBrief } from "@/lib/ai/director";

// Mismo techo que el POST del brief: corridas reales medidas de 74-144 s.
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET no configurado: el brief automático está apagado" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  if (!aiConfigured()) {
    return NextResponse.json({ error: "Falta ANTHROPIC_API_KEY" }, { status: 503 });
  }

  const gasto = await gastoDeHoyUSD();
  if (gasto != null && gasto >= AI_DAILY_BUDGET_USD) {
    return NextResponse.json(
      {
        error:
          `Se alcanzó el tope de gasto de IA del día ` +
          `(USD ${gasto.toFixed(2)} de ${AI_DAILY_BUDGET_USD}).`,
      },
      { status: 429 }
    );
  }

  try {
    const { runId } = await generateMorningBrief({ requestedBy: null });
    return NextResponse.json({ ok: true, runId });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Error inesperado al generar el brief";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

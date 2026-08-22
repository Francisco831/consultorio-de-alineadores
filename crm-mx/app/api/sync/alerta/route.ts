// /api/sync/alerta — alerta de rechazos de propuesta (AR) → Slack.
//
// La dispara el cron de Vercel cada 10 minutos (vercel.json) con
// `Authorization: Bearer $CRON_SECRET`, igual que /api/sync/noloco. Corrida
// manual: mismo curl con el header. Reemplaza al launchd de la Mac de Pancho
// (21/8/26). El estado anti-re-aviso está en la base (alerta_rechazos_estado),
// así que correrla de más no duplica avisos.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { correrAlertaRechazos } from "@/lib/alerta-rechazos";

// Login + ~4 páginas de comunicaciones + un query de casos: 10-30 s medidos
// en la versión python; 120 deja margen de sobra sin acercarse al techo (300).
export const maxDuration = 120;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET no configurado: la alerta automática está apagada" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const email = process.env.KEEPSMILING_EMAIL;
  const password = process.env.KEEPSMILING_PASSWORD;
  if (!email || !password) {
    return NextResponse.json(
      { error: "Faltan KEEPSMILING_EMAIL / KEEPSMILING_PASSWORD (credenciales Noloco)" },
      { status: 503 }
    );
  }
  const webhook = process.env.SLACK_WEBHOOK_ALERTA_RECHAZOS;
  if (!webhook?.startsWith("https://hooks.slack.com/")) {
    return NextResponse.json(
      { error: "Falta SLACK_WEBHOOK_ALERTA_RECHAZOS (webhook del canal #alertas-rechazos)" },
      { status: 503 }
    );
  }
  const db = serviceClient();
  if (!db) {
    return NextResponse.json(
      { error: "Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" },
      { status: 503 }
    );
  }

  const logs: string[] = [];
  try {
    const r = await correrAlertaRechazos(db, email, password, webhook, (s) => logs.push(s));
    if (r.avisados > 0) {
      await db.from("sync_runs").insert({
        source: "alerta-rechazos",
        status: "ok",
        finished_at: new Date().toISOString(),
        rows_upserted: r.avisados,
        log: logs,
      });
    }
    return NextResponse.json({ ok: true, ...r, logs });
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    await db.from("sync_runs").insert({
      source: "alerta-rechazos",
      status: "error",
      finished_at: new Date().toISOString(),
      log: [...logs, detalle],
    });
    return NextResponse.json({ error: detalle, logs }, { status: 500 });
  }
}

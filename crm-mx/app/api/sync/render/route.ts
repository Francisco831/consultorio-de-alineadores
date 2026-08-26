// /api/sync/render — espejo del estado del render (keepsmiling-v2 → cases.video_*).
//
// La dispara el cron de Vercel a la media de cada hora par (vercel.json), o sea
// 30 minutos DESPUÉS de /api/sync/noloco: el orden importa, porque el sync de
// Noloco es el que crea los casos nuevos y esta ruta lo único que hace es
// anotarles en qué anda el render. Corrida manual: el mismo curl con
// `Authorization: Bearer $CRON_SECRET`.
//
// Es idempotente y no borra nada: reescribe las columnas video_* de los casos
// que cambiaron en v2. Correrla de más no rompe nada; correrla de menos deja la
// pantalla /seguimiento mostrando el estado de la última corrida.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sincronizarRenderV2 } from "@/lib/render-v2-sync";

// 6 páginas de casos MX + 2 lecturas de cases + los updates agrupados: medido a
// mano el 26/8 son ~15 s en régimen. La primera corrida escribe las 1.051 filas
// (todas las columnas nacen en NULL), por eso el techo generoso.
export const maxDuration = 300;

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
      { error: "CRON_SECRET no configurado: el sync de renders está apagado" },
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
  const db = serviceClient();
  if (!db) {
    return NextResponse.json(
      { error: "Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" },
      { status: 503 }
    );
  }

  const logs: string[] = [];
  try {
    const r = await sincronizarRenderV2(db, email, password, (s) => logs.push(s));
    await db.from("sync_runs").insert({
      source: "render-v2",
      status: "ok",
      finished_at: new Date().toISOString(),
      rows_upserted: r.actualizados,
      log: logs,
    });
    return NextResponse.json({ ok: true, ...r, logs });
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    await db.from("sync_runs").insert({
      source: "render-v2",
      status: "error",
      finished_at: new Date().toISOString(),
      log: [...logs, detalle],
    });
    return NextResponse.json({ error: detalle, logs }, { status: 500 });
  }
}

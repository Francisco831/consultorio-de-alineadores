// /api/sync/calendar — la agenda de Google de cada uno al CRM.
//
// Cron de Vercel (vercel.json, 12:45 UTC = 06:45 CDMX): la agenda del día tiene
// que estar cargada ANTES de que arranque la jornada, para que la primera
// llamada ya llegue con el brief del doctor.
//
// Una TERNA de envs por persona, igual que INTRANET_EMAIL/_PASSWORD en
// /api/sync/actividades: CALENDAR_URL + CALENDAR_SECRET + CALENDAR_PROFILE, y
// después _2, _3, _4. Sumar a alguien es desplegar gas-calendar.gs en su cuenta
// y agregar su terna en Vercel — no se toca código. Ver docs/CALENDAR.md.
//
// Mismo contrato que las otras rutas de sync: Bearer CRON_SECRET, corrida
// registrada en sync_runs (source 'calendar'), idempotente.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { norm, perfilPorPista } from "@/lib/actividades-sync";
import { sincronizarCalendar } from "@/lib/calendar-sync";

export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET no configurado: el sync está apagado" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const agendas: { url: string; secret: string; profile: string }[] = [];
  for (const suf of ["", "_2", "_3", "_4"]) {
    const url = process.env[`CALENDAR_URL${suf}`];
    const sec = process.env[`CALENDAR_SECRET${suf}`];
    const profile = process.env[`CALENDAR_PROFILE${suf}`];
    if (url && sec && profile) agendas.push({ url, secret: sec, profile });
  }
  if (agendas.length === 0) {
    return NextResponse.json(
      {
        error:
          "Ninguna agenda configurada: falta la terna CALENDAR_URL / CALENDAR_SECRET / CALENDAR_PROFILE",
      },
      { status: 503 }
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json(
      { error: "Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" },
      { status: 503 }
    );
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  const { data: run } = await db
    .from("sync_runs")
    .insert({ source: "calendar", status: "running" })
    .select("id")
    .single();

  // cada agenda falla por separado: que Rocío haya vencido la autorización del
  // Apps Script no puede dejar sin agenda a los demás
  const resumen: Record<string, unknown>[] = [];
  const errores: string[] = [];
  for (const a of agendas) {
    try {
      const profileId = await perfilPorPista(db, norm(a.profile));
      if (!profileId) {
        errores.push(`${a.profile}: no hay ningún perfil con ese nombre en profiles`);
        continue;
      }
      const rep = await sincronizarCalendar(db, a.url, a.secret, profileId, log);
      resumen.push({ profile: a.profile, ...rep });
    } catch (e) {
      errores.push(`${a.profile}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const status = resumen.length === 0 && errores.length > 0 ? "error" : "ok";
  if (run) {
    await db
      .from("sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status,
        rows_upserted: resumen.reduce((n, r) => n + Number(r.upserteados ?? 0), 0),
        log: { resumen, errores, logs },
      })
      .eq("id", run.id);
  }
  return NextResponse.json(
    { ok: status === "ok", resumen, errores, logs },
    { status: status === "ok" ? 200 : 500 }
  );
}

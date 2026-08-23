// /api/sync/actividades — actividad comercial al CRM, todos los días.
//
// Cron de Vercel (vercel.json, 15:00 UTC = 09:00 CDMX). Dos fuentes con API:
// contact points del intranet (eventos de los asesores) y pedidos de
// modificación de casos MX (Noloco v2 — lo que alimenta el timeline de
// revisión clínica por doctora). Las llamadas de Rocío del sheet NO están acá:
// esa planilla no tiene API — se importan con el script o se cargan en el CRM.
//
// Mismo contrato que /api/sync/noloco: Bearer CRON_SECRET, corrida registrada
// en sync_runs (source 'actividades'), idempotente (dedup por doctor+día+texto).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  sincronizarContactPoints,
  sincronizarComunicaciones,
} from "@/lib/actividades-sync";

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
    .insert({ source: "actividades", status: "running" })
    .select("id")
    .single();

  const resumen: Record<string, unknown> = {};
  const errores: string[] = [];

  // cada fuente falla por separado: que el intranet esté caído no debe
  // frenar las comunicaciones de Noloco, ni al revés
  //
  // SYNC POR USUARIO (22/8): el intranet delimita por cuenta — cada login ve
  // solo SUS eventos, y la atribución sale de la identidad que devuelve el
  // login. Un par de envs por persona: INTRANET_EMAIL/INTRANET_PASSWORD (Juan),
  // INTRANET_EMAIL_2/INTRANET_PASSWORD_2 (Rocío), _3, _4… Agregar el par en
  // Vercel es TODO lo que hace falta para sumar a alguien.
  const cuentas: { email: string; password: string }[] = [];
  for (const suf of ["", "_2", "_3", "_4"]) {
    const e = process.env[`INTRANET_EMAIL${suf}`];
    const p = process.env[`INTRANET_PASSWORD${suf}`];
    if (e && p) cuentas.push({ email: e, password: p });
  }
  if (cuentas.length > 0) {
    const reportes = [];
    for (const c of cuentas) {
      try {
        reportes.push(await sincronizarContactPoints(db, c.email, c.password, log));
      } catch (e) {
        errores.push(
          `contact points (${c.email}): ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    if (reportes.length > 0) resumen.contactPoints = reportes;
  } else {
    log("INTRANET_EMAIL/INTRANET_PASSWORD sin configurar: contact points salteados");
  }

  const ksEmail = process.env.KEEPSMILING_EMAIL;
  const ksPass = process.env.KEEPSMILING_PASSWORD;
  if (ksEmail && ksPass) {
    try {
      resumen.comunicaciones = await sincronizarComunicaciones(db, ksEmail, ksPass, log);
    } catch (e) {
      errores.push(`comunicaciones: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    log("KEEPSMILING_EMAIL/KEEPSMILING_PASSWORD sin configurar: comunicaciones salteadas");
  }

  const status = errores.length > 0 && Object.keys(resumen).length === 0 ? "error" : "ok";
  if (run) {
    await db
      .from("sync_runs")
      .update({
        finished_at: new Date().toISOString(),
        status,
        log: { resumen, errores, logs },
      })
      .eq("id", run.id);
  }
  return NextResponse.json(
    { ok: status === "ok", resumen, errores, logs },
    { status: status === "ok" ? 200 : 500 }
  );
}

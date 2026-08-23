// /api/sync/asistencia — cierre del día hábil: ¿el equipo (Juan, Rocío) entró
// al CRM y cargó algo hoy? Si a alguien le falta, avisa por Slack a Pancho
// ("si un día hábil no lo completan que me llegue una alarma", 22/8).
//
// La dispara el cron de Vercel a las 23:30 UTC de lunes a viernes (17:30 CDMX
// / 20:30 ART — fin de la jornada en los dos husos) con
// `Authorization: Bearer $CRON_SECRET`. Corrida manual: mismo curl; con
// `?forzar=1` saltea el guard de fin de semana y manda el resumen a Slack
// aunque esté todo en orden (sirve para probar el canal).
//
// Qué mira, por cada perfil activo que no sea ADMIN ni VIEWER:
//  - "entró": auth.users.last_sign_in_at cae en el día de hoy (México). Si la
//    sesión quedó abierta de otro día ese dato no se mueve — por eso la alarma
//    NO salta solo por el login: salta cuando no CARGÓ nada.
//  - "cargó": actividades creadas + tareas creadas + tareas completadas hoy.
// El aviso sale al webhook SLACK_WEBHOOK_ASISTENCIA si existe; si no, al de
// alertas de rechazos (mismo canal #alertas-rechazos).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { todayMX } from "@/lib/dates";
import { MX_TZ, MX_OFFSET } from "@/lib/actividad-equipo";

export const maxDuration = 60;

const PANEL_URL = "https://crm-mx-puce.vercel.app/panel";

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
      { error: "CRON_SECRET no configurado: la alarma está apagada" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const webhook =
    process.env.SLACK_WEBHOOK_ASISTENCIA ??
    process.env.SLACK_WEBHOOK_ALERTA_RECHAZOS;
  if (!webhook?.startsWith("https://hooks.slack.com/")) {
    return NextResponse.json(
      { error: "Falta SLACK_WEBHOOK_ASISTENCIA (o SLACK_WEBHOOK_ALERTA_RECHAZOS)" },
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

  const forzar = new URL(req.url).searchParams.get("forzar") === "1";
  const finde = ["Sat", "Sun"].includes(
    new Intl.DateTimeFormat("en-US", { timeZone: MX_TZ, weekday: "short" }).format(
      new Date()
    )
  );
  if (finde && !forzar) {
    return NextResponse.json({ ok: true, skip: "fin de semana en México" });
  }

  const hoy = todayMX();
  const desde = `${hoy}T00:00:00${MX_OFFSET}`;
  const diaMXDe = new Intl.DateTimeFormat("en-CA", { timeZone: MX_TZ });
  const horaMX = new Intl.DateTimeFormat("es-MX", {
    timeZone: MX_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });

  try {
    // a quiénes se controla: el equipo operativo (hoy: Juan y Rocío)
    const { data: perfiles, error: ePerf } = await db
      .from("profiles")
      .select("id, nombre, rol")
      .eq("activo", true)
      .not("rol", "in", '("ADMIN","VIEWER")');
    if (ePerf) throw new Error(`profiles: ${ePerf.message}`);

    const { data: usersData, error: eUsers } = await db.auth.admin.listUsers({
      perPage: 100,
    });
    if (eUsers) throw new Error(`auth.listUsers: ${eUsers.message}`);
    const signinDe = new Map(
      usersData.users.map((u) => [u.id, u.last_sign_in_at ?? null])
    );

    const personas = await Promise.all(
      (perfiles ?? []).map(async (p) => {
        const [acts, tareasNuevas, tareasHechas] = await Promise.all([
          db
            .from("activities")
            .select("id", { count: "exact", head: true })
            .eq("created_by", p.id)
            .eq("is_demo", false)
            .gte("created_at", desde),
          db
            .from("tasks")
            .select("id", { count: "exact", head: true })
            .eq("created_by", p.id)
            .eq("is_demo", false)
            .gte("created_at", desde),
          db
            .from("tasks")
            .select("id", { count: "exact", head: true })
            .eq("assigned_to", p.id)
            .eq("status", "completada")
            .eq("is_demo", false)
            .gte("completed_at", desde),
        ]);
        const cargas =
          (acts.count ?? 0) + (tareasNuevas.count ?? 0) + (tareasHechas.count ?? 0);
        const signin = signinDe.get(p.id) ?? null;
        const entroHoy = signin != null && diaMXDe.format(new Date(signin)) === hoy;
        return {
          nombre: p.nombre.split(" ")[0],
          entroHoy,
          hora: entroHoy && signin ? horaMX.format(new Date(signin)) : null,
          cargas,
        };
      })
    );

    // la alarma es por NO cargar: el login puede no moverse con la sesión
    // abierta, pero si cargó algo es obvio que estuvo adentro
    const faltan = personas.filter((p) => p.cargas === 0);
    const avisar = faltan.length > 0 || forzar;

    if (avisar) {
      const diaLabel = new Intl.DateTimeFormat("es-MX", {
        timeZone: MX_TZ,
        weekday: "long",
        day: "numeric",
        month: "numeric",
      }).format(new Date());
      const linea = (p: (typeof personas)[number]) =>
        p.cargas === 0
          ? p.entroHoy
            ? `• *${p.nombre}*: entró (${p.hora}) pero no cargó nada`
            : `• *${p.nombre}*: no entró hoy y no cargó nada`
          : `• *${p.nombre}*: ${p.cargas} carga${p.cargas > 1 ? "s" : ""}${p.entroHoy ? ` (entró ${p.hora})` : ""} ✓`;
      const texto =
        (faltan.length > 0
          ? `⚠ *CRM MX — cierre del ${diaLabel}: falta actividad*\n`
          : `✅ *CRM MX — cierre del ${diaLabel}: todos al día* (aviso forzado de prueba)\n`) +
        personas.map(linea).join("\n") +
        `\n<${PANEL_URL}|Ver panel>`;
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: texto }),
      });
      if (!res.ok) throw new Error(`Slack respondió ${res.status}`);
      await db.from("sync_runs").insert({
        source: "asistencia",
        status: "ok",
        finished_at: new Date().toISOString(),
        rows_upserted: faltan.length,
        log: personas.map(
          (p) => `${p.nombre}: cargas=${p.cargas} entroHoy=${p.entroHoy}`
        ),
      });
    }

    return NextResponse.json({ ok: true, dia: hoy, personas, avisado: avisar });
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    await db.from("sync_runs").insert({
      source: "asistencia",
      status: "error",
      finished_at: new Date().toISOString(),
      log: [detalle],
    });
    return NextResponse.json({ error: detalle }, { status: 500 });
  }
}

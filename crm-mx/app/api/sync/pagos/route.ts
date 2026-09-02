// /api/sync/pagos — la planilla "Administración México" → tabla payments.
//
// Cron de Vercel (vercel.json, 23:10 UTC = 17:10 CDMX, lun-vie): cerrada la
// jornada en México, se lleva lo que se cargó ese día. Antes esto era
// `npx tsx scripts/sync-pagos-planilla.ts` corrido a mano en la Mac de Pancho:
// el 28/8/26 se mudó acá para que la cobranza del CRM no dependa de que esa
// máquina esté prendida. El script local sigue siendo el camino para el export
// .xlsx manual y para refrescar finanzas/seed-data/ (archivos de su disco).
//
// Hace las DOS mitades que antes eran dos scripts a mano:
//   1. planilla → tabla payments (sync-pagos-planilla.ts)
//   2. pagos huérfanos → su doctor (reconcile-ledger.ts), que necesita el nombre
//      crudo del profesional y por eso tiene que correr con la planilla todavía
//      en la mano — bajarla nuevo sería otra vuelta de 19 s al Apps Script.
//
// Idempotente: la external_key es adminmx:{fila}:{slot}, así que correrla de
// más es no-op. Los dos gates del script siguen enteros —deriva de filas y mes
// cerrado que se achica— y ABORTAN sin escribir. La diferencia de correr sola
// es que nadie mira la consola: por eso todo aborto y todo error avisan por
// Slack, y también avisa cuando el reconcile CREA fichas de doctor, que es la
// única cosa que hace sin que nadie se la haya pedido. Un sync que falla en
// silencio es peor que uno que no corre.
//
// Corrida manual:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://crm-mx-puce.vercel.app/api/sync/pagos

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bajarPlanilla, parsePagos, sincronizarPagos } from "@/lib/pagos-planilla";
import { reconciliarLedger } from "@/lib/ledger-reconcile";
import { todayMX } from "@/lib/dates";

// La planilla son ~1.500 filas y payments pasó las 1.000 (2 páginas): medido a
// mano son ~10 s. El techo generoso es por el Apps Script, que cuando Google lo
// tiene frío tarda decenas de segundos en responder.
export const maxDuration = 300;

const PANEL_URL = "https://crm-mx-puce.vercel.app/panel";

async function avisar(texto: string): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_PAGOS || process.env.SLACK_WEBHOOK_CRM;
  if (!webhook?.startsWith("https://hooks.slack.com/")) {
    // Sin webhook el sync corre igual: el aviso queda en el log de Vercel y el
    // resultado en sync_runs. Nunca cae al webhook de rechazos, que es el canal
    // de las ortodoncistas y no del equipo de México.
    console.warn(`[sync/pagos] falta SLACK_WEBHOOK_CRM, aviso no enviado:\n${texto}`);
    return;
  }
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: texto }),
    });
  } catch {
    // Si Slack no atiende queda la fila en sync_runs; no tirar el sync por esto.
  }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET no configurado: el sync de pagos está apagado" },
      { status: 503 }
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const planillaUrl = process.env.PLANILLA_MX_URL;
  const planillaSecret = process.env.PLANILLA_MX_SECRET;
  if (!planillaUrl || !planillaSecret) {
    return NextResponse.json(
      {
        error:
          "Faltan PLANILLA_MX_URL / PLANILLA_MX_SECRET: el Apps Script de la planilla no está cargado en Vercel (ver crm-mx/gas-pagos-planilla.LISTO.gs)",
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
  try {
    const grilla = await bajarPlanilla(planillaUrl, planillaSecret);
    const { pagos, sinFecha } = parsePagos(grilla);
    if (sinFecha) logs.push(`${sinFecha} montos sin fecha de pago, salteados`);

    const r = await sincronizarPagos(db, pagos, sinFecha, todayMX(), (s) => logs.push(s));
    await db.from("sync_runs").insert({
      source: "planilla_pagos",
      status: "ok",
      finished_at: new Date().toISOString(),
      rows_upserted: r.nuevos + r.editados,
      log: { ...r, cron: true, detalle: [...logs] },
    });

    const led = await reconciliarLedger(db, pagos, (s) => logs.push(s));
    await db.from("sync_runs").insert({
      source: "ledger_reconcile",
      status: "ok",
      finished_at: new Date().toISOString(),
      rows_upserted: led.linkeados,
      log: { ...led, cron: true },
    });

    // Vincular un pago es rutina; CREAR una ficha de doctor no. Eso se avisa,
    // porque un nombre mal tipeado en la planilla nace como doctor nuevo y el
    // único momento de agarrarlo es el día que pasa.
    if (led.creados > 0 || led.ambiguos.length > 0) {
      const partes = [`🧾 *CRM MX — sync de pagos: ${led.linkeados} pagos vinculados a su doctor*`];
      if (led.creados > 0) {
        partes.push(`*${led.creados} ficha(s) creadas* (no estaban en el CRM):`);
        partes.push(led.nuevos.map((n) => `• ${n}`).join("\n"));
      }
      if (led.ambiguos.length > 0) {
        partes.push(
          `⚠ ${led.ambiguos.length} pago(s) quedaron SIN vincular: el nombre matchea más de una ficha (probable duplicado en el CRM). Hay que resolverlo a mano:`
        );
        partes.push(led.ambiguos.map((n) => `• ${n}`).join("\n"));
      }
      partes.push(`<${PANEL_URL}|Ver panel>`);
      await avisar(partes.join("\n"));
    }

    return NextResponse.json({ ok: true, pagos: r, ledger: led, logs });
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    await db.from("sync_runs").insert({
      source: "planilla_pagos",
      status: "error",
      finished_at: new Date().toISOString(),
      log: { error: detalle.slice(0, 500), cron: true, detalle: logs },
    });
    await avisar(
      `⚠ *CRM MX — el sync de pagos no pudo correr*\n${detalle}\n` +
        (logs.length ? `\`\`\`${logs.join("\n").slice(0, 800)}\`\`\`\n` : "") +
        `Nada se escribió en el CRM. <${PANEL_URL}|Ver panel>`
    );
    return NextResponse.json({ error: detalle, logs }, { status: 500 });
  }
}

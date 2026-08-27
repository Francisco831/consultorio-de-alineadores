// El sync que ya no depende de la Mac.
//
// Hasta el 27/8/26 la caja del consultorio entraba a la base solo cuando corría
// una tarea programada de Claude en la Mac de Pancho: una vez por día, y solo si
// la Mac estaba despierta (el 27/8 durmió hasta las 09:39 y la tarea de las
// 08:30 nunca disparó). Por eso /ar/movimientos "no se actualizaba": la página
// se renderiza siempre en vivo, el que no corría era el que llena la base.
// Ahora corre acá, en Vercel, cada hora, con o sin Mac.
//
// Auth: Vercel Cron manda `Authorization: Bearer $CRON_SECRET`. Sin ese header
// la ruta no hace nada — es una URL pública que escribe en el ledger.

import { NextResponse } from "next/server";
import { clienteServicio } from "@/lib/sync/db";
import { sincronizarCajaAr, ErrorGate } from "@/lib/sync/caja-ar";
import { sincronizarMp, RangoVacio } from "@/lib/sync/mp";
import { registrarSync } from "@/lib/sync/sync-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// MP genera el reporte de forma asincrónica: hay que esperarlo despierto.
export const maxDuration = 300;

type Paso = { paso: string; estado: "ok" | "salteado" | "error"; detalle?: unknown };

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET sin configurar" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  // ?paso=caja | mp | todo (default). La caja corre cada hora; MP cada 3, que
  // es lo que aguanta sin quejarse la generación de reportes de su API.
  const paso = new URL(req.url).searchParams.get("paso") ?? "todo";
  const hacer = (p: string) => paso === "todo" || paso === p;

  const db = clienteServicio();
  const pasos: Paso[] = [];
  const linea: string[] = [];
  const log = (m: string) => { linea.push(m); console.log(m); };

  // ---------- caja del consultorio (AR) ----------
  const url = process.env.CAJA_AR_URL, cajaSecret = process.env.CAJA_AR_SECRET;
  if (!hacer("caja")) {
    /* no toca */
  } else if (!url || !cajaSecret) {
    pasos.push({ paso: "caja_ar", estado: "salteado", detalle: "faltan CAJA_AR_URL / CAJA_AR_SECRET" });
  } else {
    const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").maybeSingle();
    const corrida = await registrarSync(db, "caja_ar", cia?.id);
    try {
      const r = await sincronizarCajaAr(db, { url, secret: cajaSecret, log });
      await corrida.ok({ leidas: r.patas, escritas: r.escritas, log: { anuladas: r.anuladas, invisibles: r.invisibles } });
      pasos.push({ paso: "caja_ar", estado: "ok", detalle: { filas: r.filas, patas: r.patas, escritas: r.escritas, anuladas: r.anuladas, invisibles: r.invisibles.length } });
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      await corrida.fallo(motivo);
      // El gate frenó a propósito: la corrida queda marcada en rojo y la app lo
      // muestra en alertas. No es un 500 del cron, es un dato del negocio.
      pasos.push({ paso: "caja_ar", estado: "error", detalle: motivo });
      if (!(e instanceof ErrorGate)) console.error(e);
    }
  }

  // ---------- Mercado Pago ----------
  for (const empresa of hacer("mp") ? (["ar", "mx"] as const) : []) {
    const token = process.env[`MP_ACCESS_TOKEN_${empresa.toUpperCase()}`];
    if (!token) {
      pasos.push({ paso: `mp_${empresa}`, estado: "salteado", detalle: `falta MP_ACCESS_TOKEN_${empresa.toUpperCase()}` });
      continue;
    }
    const inicioMp = new Date().toISOString();
    try {
      // 12 vueltas de 5s: si MP no procesó el reporte en un minuto, lo agarra
      // la corrida de la hora que viene (el rango arranca del watermark).
      const r = await sincronizarMp(db, { empresa, token, intentos: 12, log });
      pasos.push({ paso: `mp_${empresa}`, estado: "ok", detalle: r });
    } catch (e) {
      if (e instanceof RangoVacio) {
        pasos.push({ paso: `mp_${empresa}`, estado: "salteado", detalle: e.message });
        continue;
      }
      const motivo = e instanceof Error ? e.message : String(e);
      console.error(e);
      // Sin esta fila el fallo es INVISIBLE: sincronizarMp sólo escribe en
      // sync_runs al final del camino feliz, la ruta devuelve 2xx igual, y
      // avisosDeSync no avisa por una fuente que no tiene ninguna corrida. Un
      // token vencido dejaría de traer plata sin que nadie se entere.
      // Va sólo la fila de error, NO registrarSync: su cierre 'ok' quedaría con
      // watermark NULL y se lo llevaría la consulta que calcula el rango.
      try {
        const { data: ciaMp } = await db.from("companies").select("id").eq("slug", empresa).maybeSingle();
        await db.from("sync_runs").insert({
          company_id: ciaMp?.id ?? null, source: `mp_api_${empresa}`, status: "error",
          started_at: inicioMp, finished_at: new Date().toISOString(), log: { motivo },
        });
      } catch { /* anotar el fallo no puede voltear el cron */ }
      pasos.push({ paso: `mp_${empresa}`, estado: "error", detalle: motivo });
    }
  }

  const huboError = pasos.some((p) => p.estado === "error");
  return NextResponse.json({ ok: !huboError, pasos, log: linea }, { status: huboError ? 207 : 200 });
}

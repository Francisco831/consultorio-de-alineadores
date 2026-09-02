/**
 * El molde común de las rutas de cron (/api/sync/*, /api/ops/*).
 *
 * Las 8 rutas repetían las mismas 40 líneas: leer CRON_SECRET, comparar el
 * header, armar el cliente service-role, abrir la fila de sync_runs, correr,
 * cerrarla, y avisar (o no) por Slack. Cada copia decidía distinto: algunas
 * registraban la corrida solo si había algo que avisar —o sea que "falló" y "no
 * corrió" se veían igual desde la base—, otras marcaban `ok` con errores
 * adentro, y una no registraba nada. Acá la regla es una sola: TODA corrida
 * deja una fila, con su estado real.
 *
 * La comparación del secreto es en tiempo constante (el `!==` de antes filtra,
 * en teoría, un carácter por intento; el webhook de Periskope ya lo hacía bien).
 */
import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

export interface ContextoCron {
  db: SupabaseClient;
  log: (s: string) => void;
  req: Request;
}

export interface ResultadoCron {
  /** Filas escritas, para sync_runs.rows_upserted. */
  rows?: number;
  /** Lo que se devuelve en el JSON y queda en sync_runs.log. */
  resumen?: unknown;
  /** Problemas parciales: la corrida sigue siendo ok, pero quedan anotados. */
  avisos?: string[];
  /** Texto para Slack cuando hay algo que una persona tiene que mirar. */
  avisoSlack?: string;
}

function secretoOk(recibido: string | null, esperado: string): boolean {
  if (!recibido) return false;
  const a = Buffer.from(recibido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Manda a Slack por el canal del CRM (#alertas-crm). NUNCA por el de rechazos:
 * ese lo leen las ortodoncistas y no el equipo de México (2/9/2026).
 */
export async function avisarCRM(texto: string): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_CRM;
  if (!webhook?.startsWith("https://hooks.slack.com/")) {
    console.warn(`[cron] falta SLACK_WEBHOOK_CRM, aviso no enviado:\n${texto}`);
    return;
  }
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: texto }),
    });
  } catch {
    // Si Slack no atiende, la corrida ya quedó en sync_runs: no se tira por esto.
  }
}

export async function correrCron(
  req: Request,
  opciones: {
    /** sync_runs.source — el nombre con el que se mira esta corrida en la base. */
    source: string;
    /** Si un error tiene que llegar a Slack además de a sync_runs. */
    avisarSiFalla?: boolean;
    run: (ctx: ContextoCron) => Promise<ResultadoCron>;
  }
): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: `CRON_SECRET no configurado: ${opciones.source} está apagado` },
      { status: 503 }
    );
  }
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!secretoOk(token, secret)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const db = serviceClient();
  if (!db) {
    return NextResponse.json(
      { error: "Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" },
      { status: 503 }
    );
  }

  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  // La fila se abre ANTES de correr: si el proceso muere (timeout de Vercel),
  // queda una corrida en `running` que delata el corte. Cerrarla al final es lo
  // que la vuelve ok/error.
  const { data: run } = await db
    .from("sync_runs")
    .insert({ source: opciones.source, status: "running" })
    .select("id")
    .single();

  const cerrar = async (status: "ok" | "error", rows: number | null, log: unknown) => {
    if (!run) return;
    await db
      .from("sync_runs")
      .update({ finished_at: new Date().toISOString(), status, rows_upserted: rows, log })
      .eq("id", run.id);
  };

  try {
    const r = await opciones.run({ db, log, req });
    await cerrar("ok", r.rows ?? null, { resumen: r.resumen, avisos: r.avisos, logs });
    if (r.avisoSlack) await avisarCRM(r.avisoSlack);
    return NextResponse.json({ ok: true, ...(r.resumen as object), avisos: r.avisos, logs });
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    await cerrar("error", null, { error: detalle.slice(0, 500), logs });
    if (opciones.avisarSiFalla) {
      await avisarCRM(
        `⚠ *CRM MX — ${opciones.source} falló*\n${detalle.slice(0, 400)}\n` +
          `<https://crm-mx-puce.vercel.app/ajustes|Ver estado de los procesos>`
      );
    }
    return NextResponse.json({ error: detalle, logs }, { status: 500 });
  }
}

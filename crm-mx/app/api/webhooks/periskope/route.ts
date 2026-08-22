// /api/webhooks/periskope — recibe eventos de WhatsApp de Periskope en tiempo
// real y mantiene wa_conversations al día, SIN depender de la API REST (que
// sigue plan-gated) ni del navegador de nadie.
//
// Periskope hace POST con { event_type, data, org_id, timestamp }. `data` es el
// objeto del evento; para eventos de mensaje trae chat_id, org_phone (la línea),
// from_me, timestamp, body.
//
// Autenticación: un token secreto en la URL (?k=...), igual criterio que el
// CRON_SECRET de las otras rutas. Lo generamos nosotros y va tanto en la env
// PERISKOPE_WEBHOOK_SECRET como en la URL configurada en la consola de Periskope.
// (Se prefiere esto al HMAC de Periskope porque su clave de firma queda oculta en
// la consola y no se puede leer completa; el token propio lo controlamos de punta
// a punta.) Sin la env, el endpoint responde 503 (apagado).
//
// Idempotente: un mismo chat se upsertea por periskope_chat_id. NO pisa el
// chat_name ni el doctor_id que ya tenga la fila.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 30;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Comparación en tiempo constante de dos strings. */
function tokenOk(recibido: string | null, esperado: string): boolean {
  if (!recibido) return false;
  const a = Buffer.from(recibido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Normaliza a ISO; acepta epoch (s/ms) o ISO ya hecho. */
function isoDe(ts: unknown): string | null {
  if (ts == null) return null;
  if (typeof ts === "string" && /[-T:]/.test(ts)) {
    const d = Date.parse(ts);
    return Number.isFinite(d) ? new Date(d).toISOString() : null;
  }
  let n = Number(ts);
  if (!Number.isFinite(n)) return null;
  if (n < 1e12) n *= 1000; // segundos → ms
  return new Date(n).toISOString();
}

interface MsgData {
  chat_id?: string;
  org_phone?: string;
  from_me?: boolean | string;
  timestamp?: number | string;
  chat_name?: string;
  body?: string;
}

export async function POST(req: Request) {
  const secret = process.env.PERISKOPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "PERISKOPE_WEBHOOK_SECRET no configurado" }, { status: 503 });
  }

  // token por query (?k=) o header, para no exponerlo en el body
  const url = new URL(req.url);
  const token = url.searchParams.get("k") ?? req.headers.get("x-webhook-token");
  if (!tokenOk(token, secret)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  let evt: { event_type?: string; data?: unknown };
  try {
    evt = await req.json();
  } catch {
    return NextResponse.json({ error: "Body no es JSON" }, { status: 400 });
  }

  // `data` puede venir como objeto o como string JSON
  let data = evt.data as MsgData | string | undefined;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data) as MsgData;
    } catch {
      data = undefined;
    }
  }
  const msg = (data ?? {}) as MsgData;

  // Solo procesamos eventos que traen un chat de una línea. Cualquier otra cosa
  // (acks, reacciones sin chat, etc.) se acusa con 200 y se ignora.
  if (!msg.chat_id || !msg.org_phone) {
    return NextResponse.json({ ok: true, ignored: evt.event_type ?? "sin_chat" });
  }

  const db = serviceClient();
  if (!db) {
    return NextResponse.json({ error: "Supabase no configurado" }, { status: 503 });
  }

  const chatId = msg.chat_id;
  const linea = String(msg.org_phone).replace(/@.*/, "");
  const esGrupo = chatId.includes("@g.us");
  const tel = esGrupo ? null : chatId.replace(/@.*/, "");
  const fromMe = msg.from_me === true || msg.from_me === "true";

  // fila existente: para no pisar chat_name/doctor_id y para mergear líneas
  const { data: prev } = await db
    .from("wa_conversations")
    .select("id, lineas, chat_name, doctor_id")
    .eq("periskope_chat_id", chatId)
    .maybeSingle();

  const lineas = Array.from(new Set([...(prev?.lineas ?? []), linea]));

  // match de doctor solo si la fila aún no tiene uno (por los últimos 10 dígitos)
  let doctorId = prev?.doctor_id ?? null;
  if (!doctorId && tel) {
    const last10 = tel.slice(-10);
    const { data: docs } = await db
      .from("doctors")
      .select("id")
      .or(`phone.ilike.%${last10}%,whatsapp.ilike.%${last10}%`)
      .limit(1);
    doctorId = docs?.[0]?.id ?? null;
  }

  const row: Record<string, unknown> = {
    periskope_chat_id: chatId,
    phone: tel,
    unanswered: !fromMe, // último mensaje del cliente = espera respuesta
    activity_bucket: "7d", // acaba de llegar un evento → actividad reciente
    lineas,
    last_message_at: isoDe(msg.timestamp) ?? new Date().toISOString(),
  };
  // chat_name: no pisar el existente; los eventos de mensaje no traen nombre, así
  // que solo lo seteamos al CREAR la fila (placeholder con el número/id).
  if (msg.chat_name) row.chat_name = msg.chat_name;
  else if (!prev) row.chat_name = tel ?? chatId;
  // doctor_id: solo lo mandamos si lo resolvimos (no pisar con null un vínculo).
  if (doctorId) row.doctor_id = doctorId;

  const { error } = await db
    .from("wa_conversations")
    .upsert(row, { onConflict: "periskope_chat_id" });
  if (error) {
    console.error("[webhook periskope] upsert falló:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log(
    `[webhook periskope] ${evt.event_type ?? "?"} chat=${chatId} linea=${linea} unanswered=${!fromMe}`
  );
  return NextResponse.json({ ok: true });
}

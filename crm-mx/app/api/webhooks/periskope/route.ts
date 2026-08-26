// /api/webhooks/periskope — recibe eventos de WhatsApp de Periskope en tiempo
// real y mantiene wa_conversations al día, SIN depender de la API REST (que
// sigue plan-gated) ni del navegador de nadie.
//
// ESTADO AL 26/8/2026 — LEER ANTES DE TOCAR NADA ACÁ:
// Este endpoint está vivo y con su secreto puesto en Vercel Production desde el
// 22/8 (un POST sin token devuelve 401; si faltara la env devolvería 503), se
// probó de punta a punta con un evento sintético, y el webhook YA está dado de
// alta en la consola de Periskope desde ese mismo día. Y sin embargo las 1.490
// filas de wa_conversations tienen last_message_at en NULL, y la ÚNICA línea del
// repo que escribe esa columna es la de acá abajo: en 4 días no entró un evento.
//
// NO ES UN BUG DE ESTE CÓDIGO. La organización de Periskope figura Enterprise
// Activa pero el sistema la trata como free: la API REST devuelve 401 "available
// only for active pro and enterprise plans", Automation Rules dice "Pro only" y
// el contador Total events marca 0 pese al tráfico real. Está pendiente el mail
// a support@periskope.app desde el 22/8. Cuando lo corrijan, esto fluye solo.
//
// Antes de "arreglar" nada acá, leer docs/WHATSAPP_PERISKOPE.md. Mientras tanto,
// todo lo que /hoy y /panel muestran como "esperando respuesta" es la foto del
// export del 7/8.
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

/** El preview del último mensaje: alcanza para decidir y para mostrar una línea. */
const BODY_MAX = 2000;

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
  // OJO: si Periskope nombra distinto estos dos campos, TODOS los eventos caen
  // acá y el resultado es idéntico a "no está configurado". Cómo distinguirlo
  // mirando los logs de Vercel: docs/WHATSAPP_PERISKOPE.md.
  if (!msg.chat_id || !msg.org_phone) {
    console.log(
      `[webhook periskope] ${evt.event_type ?? "?"} ignorado — sin chat_id/org_phone. Campos recibidos: ${Object.keys(msg).join(",") || "(ninguno)"}`
    );
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
  const body = typeof msg.body === "string" ? msg.body.slice(0, BODY_MAX) : null;

  // fila existente: para no pisar chat_name/doctor_id y para mergear líneas
  const { data: prev } = await db
    .from("wa_conversations")
    .select("id, lineas, chat_name, doctor_id")
    .eq("periskope_chat_id", chatId)
    .maybeSingle();

  const lineas = Array.from(new Set([...(prev?.lineas ?? []), linea]));

  // Match de doctor por teléfono: SOLO cuando el chat es nuevo para el CRM.
  // Antes se reintentaba en cada mensaje de cualquier fila sin doctor, y eso son
  // 1.306 chats (de 1.490) donde la query ya falló y va a seguir fallando: el
  // teléfono del doctor no cambia porque nos escriba otra vez. Una consulta a
  // doctors por mensaje entrante, siempre en vano. El barrido masivo —el que sí
  // puede encontrar vínculos nuevos, porque corre contra el padrón entero— es
  // scripts/import-whatsapp.ts; el webhook solo engancha lo que nace nuevo.
  let doctorId: string | null = null;
  if (!prev && tel) {
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
    // OJO: acá ya NO va `unanswered`. Hasta el 26/8 esta fila decía
    // `unanswered: !fromMe`, o sea "habló el doctor último = pendiente", y un
    // "de nada" contaba como pendiente. Desde la migración 0041 lo calcula el
    // trigger wa_conv_unanswered a partir del body, con wa_requiere_respuesta().
    // La regla vive UNA sola vez, en la base, y la comparten el webhook y
    // cualquier backfill. Si el webhook la escribiera igual, el trigger la
    // pisaría: no la pongas de nuevo.
    last_message_body: body,
    last_message_from_me: fromMe,
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
    `[webhook periskope] ${evt.event_type ?? "?"} chat=${chatId} linea=${linea} from_me=${fromMe} body=${body ? body.length : 0}ch`
  );
  return NextResponse.json({ ok: true });
}

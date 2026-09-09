// /api/sync/whatsapp — WhatsApp directo (sin Periskope).
//
// Recibe los mensajes que Claude lee de WhatsApp Web (línea +54 9 11 2374-0762
// en el Chrome de Pancho, perfil "Keep") y deja el CRM al día:
//
//   · wa_conversations / wa_messages  → el chat y sus mensajes (idempotente por id)
//   · unanswered                      → lo decide el trigger de la base (0041)
//   · activities (type whatsapp)      → una por doctor y día, con resumen del modelo
//   · ai_recommendations              → los pedidos del doctor como tareas PROPUESTAS
//   · Slack #alertas-crm              → el aviso del día
//
// Contrato: POST con Bearer CRON_SECRET y el JSON de lib/whatsapp/directo.ts
// (bodySchema). GET con el mismo Bearer devuelve hasta dónde se leyó la última
// vez (`leido_hasta`), que es el punto de partida de la lectura siguiente.
//
// Cómo se corre: skill /revision-whatsapp del repo (.claude/skills). No hay cron:
// la lectura la hace Claude desde el navegador, así que la corrida arranca
// cuando Pancho la pide. Documentación: docs/WHATSAPP_DIRECTO.md.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { correrCron, serviceClient } from "@/lib/cron";
import { fetchAll } from "@/scripts/lib/fetch-all";
import {
  agruparPorDia,
  bodySchema,
  canonTel,
  esDelEquipo,
  indexarDoctores,
  matchearDoctor,
  normalizarTexto,
  syncKeyActividad,
  telDeJid,
  textoAvisoSlack,
  transcripcion,
  ultimoMensaje,
  type Body,
  type Chat,
  type DoctorIndexable,
  type Mensaje,
  type ResultadoChat,
  type ResultadoCorrida,
} from "@/lib/whatsapp/directo";
import { resumirDia, WA_AI_MODEL } from "@/lib/whatsapp/resumen";

export const runtime = "nodejs";
// Una llamada al modelo por (chat, día). Con 30 chats son ~2-3 minutos.
export const maxDuration = 300;

const SOURCE = "whatsapp";
const AGENTE = "doctor_success";
const TIPO_RECOMENDACION = "whatsapp_pedido";
const MAX_PEDIDOS_ABIERTOS = 3;
const MAX_RESUMENES_POR_CORRIDA = 60;
const BODY_MAX = 2000;

function secretoOk(recibido: string | null, esperado: string): boolean {
  if (!recibido) return false;
  const a = Buffer.from(recibido, "utf8");
  const b = Buffer.from(esperado, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

// ---------------------------------------------------------------------------
// GET — ¿hasta dónde se leyó la última vez?
// ---------------------------------------------------------------------------
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET no configurado" }, { status: 503 });
  if (!secretoOk(bearer(req), secret)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Supabase no configurado" }, { status: 503 });

  const linea = new URL(req.url).searchParams.get("linea");
  const { data, error } = await db
    .from("sync_runs")
    .select("started_at, finished_at, rows_upserted, log")
    .eq("source", SOURCE)
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(30);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const corridas = (data ?? [])
    .map((r) => {
      const resumen = (r.log as { resumen?: Record<string, unknown> } | null)?.resumen ?? {};
      return {
        linea: String(resumen.linea ?? ""),
        leido_hasta: (resumen.leido_hasta as string | undefined) ?? null,
        corrida: r.started_at as string,
        mensajes: r.rows_upserted as number | null,
      };
    })
    .filter((c) => c.leido_hasta && (!linea || c.linea === linea));

  // la última por línea
  const porLinea = new Map<string, (typeof corridas)[number]>();
  for (const c of corridas) if (!porLinea.has(c.linea)) porLinea.set(c.linea, c);

  return NextResponse.json({ ok: true, lineas: [...porLinea.values()] });
}

// ---------------------------------------------------------------------------
// POST — ingesta
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  // El body se lee ANTES de correrCron para poder decidir el `source`: una
  // simulación no puede dejar una corrida `whatsapp` ok, porque el GET la
  // tomaría como watermark real.
  let crudo: unknown;
  try {
    crudo = await req.json();
  } catch {
    return NextResponse.json({ error: "Body no es JSON" }, { status: 400 });
  }
  const parse = bodySchema.safeParse(crudo);
  if (!parse.success) {
    return NextResponse.json(
      { error: "Body inválido", detalle: parse.error.issues.slice(0, 10) },
      { status: 400 }
    );
  }
  const body = parse.data;
  const dry = body.dry_run === true;
  const soloMensajes = body.solo_mensajes === true;

  return correrCron(req, {
    source: dry ? `${SOURCE}-dry` : SOURCE,
    avisarSiFalla: !dry,
    run: async ({ db, log }) => {
      const r = await ingestar(db, body, log);
      const conDoctor = r.chats.filter((c) => c.doctor && c.mensajes_nuevos > 0);
      const resumen = {
        linea: r.linea,
        leido_hasta: r.leido_hasta,
        dry_run: dry,
        solo_mensajes: soloMensajes,
        chats: r.chats.length,
        con_doctor: conDoctor.length,
        esperan_respuesta: conDoctor.filter((c) => c.espera_respuesta).length,
        sin_ficha: r.chats.filter((c) => !c.doctor && c.mensajes_nuevos > 0).length,
        pedidos: conDoctor.reduce((n, c) => n + c.pedidos.length, 0),
        costo_usd: r.costo_usd,
        modelo: WA_AI_MODEL,
        detalle: r.chats,
      };
      const mensajes = r.chats.reduce((n, c) => n + c.mensajes_nuevos, 0);
      return {
        rows: mensajes,
        resumen,
        // el backfill no avisa: el aviso habla de "hoy" y esto es historia
        avisoSlack: dry || soloMensajes ? undefined : textoAvisoSlack(r),
      };
    },
  });
}

// ---------------------------------------------------------------------------

interface ConvPrev {
  id: string;
  doctor_id: string | null;
  chat_name: string | null;
  lineas: string[] | null;
  last_message_at: string | null;
}

async function enLotes<T, R>(items: T[], tam: number, fn: (lote: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += tam) out.push(...(await fn(items.slice(i, i + tam))));
  return out;
}

async function ingestar(
  db: SupabaseClient,
  body: Body,
  log: (s: string) => void
): Promise<ResultadoCorrida> {
  const dry = body.dry_run === true;
  const soloMensajes = body.solo_mensajes === true;
  const linea = body.linea;

  // quién opera la línea → created_by de las actividades
  const { data: perfil } = await db
    .from("profiles")
    .select("id, nombre")
    .eq("periskope_org_phone", linea)
    .maybeSingle();
  const operador = (perfil as { id: string; nombre: string } | null) ?? null;
  log(operador ? `línea ${linea} → ${operador.nombre}` : `línea ${linea} sin persona asignada (profiles.periskope_org_phone)`);

  // padrón entero: un select plano corta en 1.000 y deja doctores sin vínculo
  const doctores = await fetchAll<DoctorIndexable>(
    db,
    "doctors",
    "id, nombre, phone, whatsapp, is_accredited, case_count"
  );
  const idx = indexarDoctores(doctores);

  // lo que ya conocemos de estos chats y mensajes
  const chatIds = body.chats.map((c) => c.chat_id);
  const previas = await enLotes(chatIds, 200, async (lote) => {
    const { data, error } = await db
      .from("wa_conversations")
      .select("id, periskope_chat_id, doctor_id, chat_name, lineas, last_message_at")
      .in("periskope_chat_id", lote);
    if (error) throw new Error(`wa_conversations: ${error.message}`);
    return (data ?? []) as (ConvPrev & { periskope_chat_id: string })[];
  });
  const prevPorChat = new Map(previas.map((p) => [p.periskope_chat_id, p]));

  const idsMensajes = body.chats.flatMap((c) => c.mensajes.map((m) => m.id));
  const conocidos = new Set(
    await enLotes(idsMensajes, 300, async (lote) => {
      const { data, error } = await db
        .from("wa_messages")
        .select("periskope_msg_id")
        .in("periskope_msg_id", lote);
      if (error) throw new Error(`wa_messages: ${error.message}`);
      return (data ?? []).map((r) => r.periskope_msg_id as string);
    })
  );

  const resultado: ResultadoCorrida = {
    linea,
    leido_hasta: body.leido_hasta,
    chats: [],
    costo_usd: 0,
    dry_run: dry,
  };
  let resumenes = 0;

  for (const chat of body.chats) {
    const prev = prevPorChat.get(chat.chat_id) ?? null;
    const match = prev?.doctor_id
      ? { doctor: doctores.find((d) => d.id === prev.doctor_id) ?? null, via: "telefono" as const }
      : matchearDoctor(chat, idx);
    const doctor = match.doctor;
    const nuevos = chat.mensajes.filter((m) => !conocidos.has(m.id));
    const ultimo = ultimoMensaje(chat.mensajes);
    const ultimoNuestro = ultimo ? esDelEquipo(ultimo) : true;

    const item: ResultadoChat = {
      chat_id: chat.chat_id,
      nombre: chat.nombre,
      es_grupo: chat.es_grupo,
      doctor: doctor ? { id: doctor.id, nombre: doctor.nombre ?? "(sin nombre)" } : null,
      via: match.via,
      candidatos: "candidatos" in match ? match.candidatos : undefined,
      mensajes_nuevos: nuevos.length,
      ultimo_es_nuestro: ultimoNuestro,
      espera_respuesta: !ultimoNuestro,
      resumen: null,
      pedidos: [],
    };
    resultado.chats.push(item);

    if (dry) continue;

    // --- wa_conversations -------------------------------------------------
    const tel = chat.telefono ? canonTel(chat.telefono) : telDeJid(chat.chat_id);
    const lineas = Array.from(new Set([...(prev?.lineas ?? []), linea]));
    const fila: Record<string, unknown> = {
      periskope_chat_id: chat.chat_id,
      phone: tel,
      lineas,
    };
    if (!prev?.chat_name) fila.chat_name = chat.nombre;
    if (doctor && !prev?.doctor_id) fila.doctor_id = doctor.id;
    // el bucket sale de la edad del último mensaje, no de "hubo mensajes
    // nuevos": en la corrida diaria da lo mismo ('7d'), pero un backfill trae
    // chats cuyo último mensaje es de junio y ésos no están "activos esta semana"
    if (ultimo) {
      const edadDias = (Date.now() - Date.parse(ultimo.ts)) / 86_400_000;
      fila.activity_bucket = edadDias <= 7 ? "7d" : edadDias <= 30 ? "30d" : "mas_30d";
    }
    // Backfill: un mensaje de hace dos meses sin contestar no es "esperando
    // respuesta" hoy, es historia. En solo_mensajes el estado del chat (último
    // mensaje, pendiente) solo se toca si ese último mensaje tiene menos de
    // 7 días —lo que la corrida diaria ya cubre—; los mensajes en sí se
    // guardan igual, que es lo que el nivel de interacción necesita.
    const esReciente = ultimo ? Date.now() - Date.parse(ultimo.ts) <= 7 * 86_400_000 : false;
    if (ultimo && (!soloMensajes || esReciente)
        && (!prev?.last_message_at || Date.parse(ultimo.ts) > Date.parse(prev.last_message_at))) {
      fila.last_message_at = new Date(ultimo.ts).toISOString();
      fila.last_message_body = (ultimo.texto ?? (ultimo.tipo && ultimo.tipo !== "chat" ? `[${ultimo.tipo}]` : null))?.slice(0, BODY_MAX) ?? null;
      // "nuestro" incluye a las otras líneas KS: si contestó Juan, no está pendiente
      fila.last_message_from_me = ultimoNuestro;
    }
    const { data: conv, error: errConv } = await db
      .from("wa_conversations")
      .upsert(fila, { onConflict: "periskope_chat_id" })
      .select("id")
      .single();
    if (errConv || !conv) throw new Error(`wa_conversations ${chat.chat_id}: ${errConv?.message ?? "sin fila"}`);

    // --- wa_messages --------------------------------------------------------
    if (nuevos.length) {
      const filas = nuevos.map((m) => ({
        conversation_id: conv.id,
        direction: m.from_me ? "out" : "in",
        body: m.texto ?? null,
        sent_at: new Date(m.ts).toISOString(),
        periskope_msg_id: m.id,
        meta: {
          fuente: body.fuente,
          linea,
          autor: m.autor ?? null,
          autor_tel: m.autor_tel ?? null,
          tipo: m.tipo ?? "chat",
          chat_name: chat.nombre,
          equipo: esDelEquipo(m),
        },
      }));
      const { error: errMsg } = await db
        .from("wa_messages")
        .upsert(filas, { onConflict: "periskope_msg_id", ignoreDuplicates: true });
      if (errMsg) throw new Error(`wa_messages ${chat.chat_id}: ${errMsg.message}`);
    }

    if (!doctor || !nuevos.length) continue;
    // backfill: los mensajes ya están guardados y con eso alcanza para el
    // nivel de interacción; resumir tres meses de días viejos costaría plata
    // y propondría tareas sobre pedidos que ya pasaron
    if (soloMensajes) continue;

    // --- actividad por día + pedidos ----------------------------------------
    for (const [dia, delDia] of agruparPorDia(nuevos)) {
      if (resumenes >= MAX_RESUMENES_POR_CORRIDA) {
        log(`tope de ${MAX_RESUMENES_POR_CORRIDA} resúmenes por corrida: ${chat.nombre} ${dia} queda sin resumir`);
        break;
      }
      // el día entero, no solo lo nuevo: si ya había mensajes de hoy en una
      // corrida anterior, el resumen se regenera con todo
      const todos = await mensajesDelDia(db, conv.id, dia, delDia);
      const texto = transcripcion(todos);
      if (!texto.trim()) continue;

      let salida;
      try {
        salida = await resumirDia({ doctorNombre: doctor.nombre ?? "Doctor", dia, transcripcion: texto });
      } catch (e) {
        log(`resumen ${chat.nombre} ${dia} falló: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      resumenes++;
      resultado.costo_usd = Math.round((resultado.costo_usd + salida.costo_usd) * 1e5) / 1e5;
      const res = salida.resumen;
      item.resumen = res.resumen;
      // el modelo vio el día entero; si dice que el último mensaje no pide
      // respuesta, el aviso lo refleja (la base igual decide con su trigger)
      item.espera_respuesta = res.pide_respuesta;

      const ultimoDia = ultimoMensaje(todos)!;
      const key = syncKeyActividad(linea, chat.chat_id, dia);
      const actividad = {
        doctor_id: doctor.id,
        type: "whatsapp",
        occurred_at: new Date(ultimoDia.ts).toISOString(),
        summary: res.resumen,
        outcome: res.tema || null,
        created_by: operador?.id ?? null,
        sync_key: key,
      };
      const { data: existente } = await db
        .from("activities")
        .select("id")
        .eq("sync_key", key)
        .maybeSingle();
      if (existente?.id) {
        const { error } = await db
          .from("activities")
          .update({ summary: actividad.summary, outcome: actividad.outcome, occurred_at: actividad.occurred_at })
          .eq("id", existente.id);
        if (error) log(`actividad ${key} no se actualizó: ${error.message}`);
        item.actividad_id = existente.id;
      } else {
        const { data: nueva, error } = await db.from("activities").insert(actividad).select("id").single();
        if (error) log(`actividad ${key} no se creó: ${error.message}`);
        item.actividad_id = nueva?.id ?? null;
      }

      for (const p of res.pedidos.slice(0, MAX_PEDIDOS_ABIERTOS)) {
        const vence = new Date(Date.parse(ultimoDia.ts) + p.vence_en_dias * 86_400_000).toISOString().slice(0, 10);
        const creado = await proponerTarea(db, {
          doctorId: doctor.id,
          titulo: p.titulo.slice(0, 80),
          tipo: p.tipo,
          vence,
          situacion: res.resumen,
          evidencia: `WhatsApp ${dia} · chat "${chat.nombre}"`,
          log,
        });
        if (creado) item.pedidos.push({ titulo: p.titulo, tipo: p.tipo, vence });
      }
    }
  }

  log(`chats ${resultado.chats.length}, resúmenes ${resumenes}, IA USD ${resultado.costo_usd.toFixed(2)}`);

  // ---------- nivel de interacción con soporte (migración 0060) ----------
  // Los mensajes recién guardados mueven el nivel de los doctores de estos
  // chats. wa_messages no tiene trigger (entran de a cientos por corrida), así
  // que se recalcula acá, una vez, la cartera entera. La red es
  // crm-interaccion-nightly a las 11:28 UTC.
  if (!dry) {
    const { error: intErr } = await db.rpc("recompute_interaccion", { p_doctor: null });
    if (intErr) log(`recompute_interaccion falló (lo cubre el cron): ${intErr.message}`);
    else log("Nivel de interacción con soporte recalculado ✓");
  }
  return resultado;
}

/** Los mensajes de un chat en un día (hora MX): los guardados más los que llegan ahora. */
async function mensajesDelDia(db: SupabaseClient, convId: string, dia: string, nuevos: Mensaje[]): Promise<Mensaje[]> {
  // el día MX cubre de 06:00Z a 06:00Z del siguiente (UTC-6; con horario de
  // verano sería 05:00, pero México lo abolió en 2022)
  const desde = new Date(`${dia}T06:00:00Z`);
  const hasta = new Date(desde.getTime() + 86_400_000);
  const { data } = await db
    .from("wa_messages")
    .select("periskope_msg_id, direction, body, sent_at, meta")
    .eq("conversation_id", convId)
    .gte("sent_at", desde.toISOString())
    .lt("sent_at", hasta.toISOString())
    .order("sent_at");
  const guardados: Mensaje[] = (data ?? []).map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    return {
      id: r.periskope_msg_id as string,
      ts: r.sent_at as string,
      from_me: r.direction === "out",
      autor: (meta.autor as string | null) ?? null,
      autor_tel: (meta.autor_tel as string | null) ?? null,
      texto: (r.body as string | null) ?? null,
      tipo: (meta.tipo as string | undefined) ?? "chat",
    };
  });
  const vistos = new Set(guardados.map((m) => m.id));
  return [...guardados, ...nuevos.filter((m) => !vistos.has(m.id))].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts)
  );
}

/**
 * Un pedido del doctor → tarea PROPUESTA (ai_recommendations, HITL). Hasta tres
 * abiertas por doctor; si ya hay una parecida abierta, no se duplica.
 */
async function proponerTarea(
  db: SupabaseClient,
  o: {
    doctorId: string;
    titulo: string;
    tipo: string;
    vence: string;
    situacion: string;
    evidencia: string;
    log: (s: string) => void;
  }
): Promise<boolean> {
  const { data: abiertas } = await db
    .from("ai_recommendations")
    .select("id, recommendation_type, recommended_action")
    .eq("doctor_id", o.doctorId)
    .eq("agent", AGENTE)
    .like("recommendation_type", `${TIPO_RECOMENDACION}%`)
    .eq("status", "propuesta");
  const lista = (abiertas ?? []) as { id: string; recommendation_type: string; recommended_action: string }[];

  const tokens = (s: string) => new Set(normalizarTexto(s).split(" ").filter((t) => t.length > 3));
  const mios = tokens(o.titulo);
  for (const a of lista) {
    const suyos = tokens(a.recommended_action);
    const comunes = [...mios].filter((t) => suyos.has(t)).length;
    if (mios.size && comunes / Math.max(mios.size, suyos.size) >= 0.6) return false; // ya está
  }
  const usados = new Set(lista.map((a) => a.recommendation_type));
  const slot = [1, 2, 3].map((n) => `${TIPO_RECOMENDACION}_${n}`).find((s) => !usados.has(s));
  if (!slot) {
    o.log(`doctor ${o.doctorId}: ya tiene ${MAX_PEDIDOS_ABIERTOS} pedidos propuestos, "${o.titulo}" no se propone`);
    return false;
  }
  const { error } = await db.from("ai_recommendations").insert({
    doctor_id: o.doctorId,
    agent: AGENTE,
    run_id: null,
    brain_version: "wa-directo-2026.09",
    model_version: WA_AI_MODEL,
    recommendation_type: slot,
    objective: "Responder un pedido que el doctor hizo por WhatsApp",
    situation: o.situacion,
    recommended_action: o.titulo,
    channel: "task",
    recommended_date: o.vence,
    why: ["El doctor lo pidió explícitamente en el WhatsApp del día"],
    evidence: [{ field: "whatsapp", value: o.evidencia }],
    confidence: 70,
    commercial_priority: 60,
    clinical_handoff: false,
    requires_user_confirmation: true,
    payload: { kind: "task", title: o.titulo, type: o.tipo, due_date: o.vence },
    status: "propuesta",
  });
  if (error) {
    o.log(`propuesta "${o.titulo}" no se creó: ${error.message}`);
    return false;
  }
  return true;
}

// tipos usados solo para documentación del contrato
export type { Chat };

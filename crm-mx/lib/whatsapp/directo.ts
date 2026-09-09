// WhatsApp directo — la lógica pura del sync de una línea leída desde
// WhatsApp Web (sin Periskope). La ruta /api/sync/whatsapp recibe los mensajes
// que Claude saca del navegador y este módulo decide:
//
//   · a qué doctor del CRM pertenece cada chat (teléfono, participantes o nombre),
//   · qué mensajes son nuevos y a qué día (hora de México) pertenecen,
//   · si el último mensaje lo escribió el equipo (esta línea u otra línea KS),
//   · el texto del aviso diario a Slack.
//
// Nada de acá toca la base ni llama al modelo: eso vive en la ruta y en
// resumen.ts. Por eso se puede testear con node:test sin credenciales.
//
// Por qué "directo" y no Periskope: la línea +54 9 11 2374-0762 se lee desde
// WhatsApp Web en el Chrome de Pancho (decisión 8/9/2026). El webhook de
// Periskope sigue mudo (docs/WHATSAPP_PERISKOPE.md); este camino no depende de él.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Contrato del POST
// ---------------------------------------------------------------------------

export const mensajeSchema = z.object({
  /** data-id de WhatsApp Web: `true_<jid>_<hash>` / `false_<jid>_<hash>`. Es el
   *  mismo id que usa Periskope como message_id, así que las dos fuentes no se
   *  pisan si algún día conviven. */
  id: z.string().min(8),
  /** ISO 8601 con zona. */
  ts: z.string().min(10),
  from_me: z.boolean(),
  /** Quién escribió (grupos). Para chats 1:1 puede venir vacío. */
  autor: z.string().nullable().optional(),
  /** Teléfono del autor si WhatsApp lo muestra (grupos). Solo dígitos o con +. */
  autor_tel: z.string().nullable().optional(),
  texto: z.string().nullable().optional(),
  /** chat | image | audio | video | document | sticker | ... (lo que se vio). */
  tipo: z.string().optional(),
});

export const chatSchema = z.object({
  /** JID de WhatsApp: 521…@c.us (persona) o 1203…@g.us (grupo). */
  chat_id: z.string().regex(/@(c\.us|g\.us|lid)$/, "chat_id tiene que ser un JID de WhatsApp"),
  nombre: z.string().min(1),
  es_grupo: z.boolean(),
  /** Teléfono del contacto en chats 1:1. */
  telefono: z.string().nullable().optional(),
  /** Teléfonos de los participantes (grupos), como los muestra el header. */
  participantes: z.array(z.string()).optional(),
  mensajes: z.array(mensajeSchema),
});

export const bodySchema = z.object({
  /** Línea leída, solo dígitos (formato de profiles.periskope_org_phone). */
  linea: z.string().regex(/^[0-9]{11,15}$/),
  fuente: z.string().default("wa_web"),
  /** Hasta qué instante se leyó el WhatsApp (ISO). Es el watermark que devuelve
   *  el GET para la próxima corrida. */
  leido_hasta: z.string().min(10),
  chats: z.array(chatSchema),
  /** Calcula y devuelve el resultado sin escribir ni llamar al modelo. */
  dry_run: z.boolean().optional(),
});

export type Mensaje = z.infer<typeof mensajeSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type Body = z.infer<typeof bodySchema>;

// ---------------------------------------------------------------------------
// Teléfonos
// ---------------------------------------------------------------------------

/**
 * Clave canónica para matchear: solo dígitos, 521XXXXXXXXXX → 52XXXXXXXXXX,
 * 10 dígitos → +52. Misma regla que scripts/lib/phone.ts (la del import), NO la
 * de lib/phone.ts (que conserva el 521 porque wa.me lo necesita).
 */
export function canonTel(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = String(p).replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("521")) d = "52" + d.slice(3);
  if (d.length === 10) d = "52" + d;
  return d.length >= 10 ? d : null;
}

/** Los últimos 10 dígitos: WhatsApp escribe los móviles MX con y sin el "1". */
export function cola10(p: string | null | undefined): string | null {
  const c = canonTel(p);
  return c ? c.slice(-10) : null;
}

/** El teléfono de un JID de persona (521…@c.us). null para grupos y @lid. */
export function telDeJid(chatId: string): string | null {
  const m = chatId.match(/^(\d{8,15})@c\.us$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Nombres
// ---------------------------------------------------------------------------

const RUIDO_NOMBRE = new Set([
  "keepsmiling",
  "keep",
  "smiling",
  "ks",
  "dra",
  "dr",
  "doctora",
  "doctor",
  "od",
  "odontologa",
  "odontologo",
  "ortodoncista",
  "ortodoncia",
  "mx",
  "mexico",
  "y",
  "e",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
]);

/** Minúsculas, sin acentos, solo letras y espacios. */
export function normalizarTexto(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens con contenido de un nombre de chat o de doctor (sin "& KeepSmiling", "Dra.", etc.). */
export function tokensNombre(s: string): string[] {
  return normalizarTexto(s)
    .split(" ")
    .filter((t) => t.length >= 2 && !RUIDO_NOMBRE.has(t) && !/^\d+$/.test(t));
}

export interface DoctorIndexable {
  id: string;
  nombre: string | null;
  phone: string | null;
  whatsapp: string | null;
  is_accredited?: boolean | null;
  case_count?: number | null;
}

export interface IndiceDoctores {
  porCola10: Map<string, DoctorIndexable[]>;
  porTokens: { tokens: Set<string>; doctor: DoctorIndexable }[];
}

export function indexarDoctores(doctores: DoctorIndexable[]): IndiceDoctores {
  const porCola10 = new Map<string, DoctorIndexable[]>();
  const porTokens: IndiceDoctores["porTokens"] = [];
  for (const d of doctores) {
    for (const p of [d.phone, d.whatsapp]) {
      const c = cola10(p);
      if (!c) continue;
      const lista = porCola10.get(c) ?? [];
      if (!lista.some((x) => x.id === d.id)) lista.push(d);
      porCola10.set(c, lista);
    }
    const tokens = new Set(tokensNombre(d.nombre ?? ""));
    if (tokens.size >= 2) porTokens.push({ tokens, doctor: d });
  }
  return { porCola10, porTokens };
}

export type MatchDoctor =
  | { doctor: DoctorIndexable; via: "telefono" | "participante" | "nombre" }
  | { doctor: null; via: "ambiguo" | "sin_match"; candidatos?: string[] };

/** Entre varios candidatos, el acreditado y con más casos gana; si empatan, ambiguo. */
function elegir(cands: DoctorIndexable[]): DoctorIndexable | null {
  if (cands.length === 1) return cands[0];
  const puntaje = (d: DoctorIndexable) => (d.is_accredited ? 1000 : 0) + (d.case_count ?? 0);
  const orden = [...cands].sort((a, b) => puntaje(b) - puntaje(a));
  return puntaje(orden[0]) > puntaje(orden[1]) ? orden[0] : null;
}

/**
 * A qué doctor pertenece un chat. Orden: teléfono del contacto → teléfonos de
 * los participantes (grupos) → nombre del chat. El nombre matchea si TODOS los
 * tokens del chat están en el nombre del doctor o al revés (los doctores están
 * cargados "Apellido Nombre" y los grupos dicen "Nombre Apellido & KeepSmiling").
 * Si dos doctores empatan, no se adivina: queda sin vínculo y se avisa.
 */
export function matchearDoctor(chat: Chat, idx: IndiceDoctores): MatchDoctor {
  const tels = [chat.telefono, telDeJid(chat.chat_id)];
  for (const t of tels) {
    const c = cola10(t);
    if (!c) continue;
    const cands = idx.porCola10.get(c);
    if (cands?.length) {
      const d = elegir(cands);
      if (d) return { doctor: d, via: "telefono" };
      return { doctor: null, via: "ambiguo", candidatos: cands.map((x) => x.nombre ?? x.id) };
    }
  }
  if (chat.participantes?.length) {
    const encontrados: DoctorIndexable[] = [];
    for (const p of chat.participantes) {
      const c = cola10(p);
      if (!c) continue;
      for (const d of idx.porCola10.get(c) ?? []) {
        if (!encontrados.some((x) => x.id === d.id)) encontrados.push(d);
      }
    }
    if (encontrados.length) {
      const d = elegir(encontrados);
      if (d) return { doctor: d, via: "participante" };
      return { doctor: null, via: "ambiguo", candidatos: encontrados.map((x) => x.nombre ?? x.id) };
    }
  }
  const tokens = tokensNombre(chat.nombre);
  if (tokens.length >= 2) {
    const cands: DoctorIndexable[] = [];
    for (const e of idx.porTokens) {
      const chatEnDoctor = tokens.every((t) => e.tokens.has(t));
      const doctorEnChat = [...e.tokens].every((t) => tokens.includes(t));
      if (chatEnDoctor || doctorEnChat) cands.push(e.doctor);
    }
    if (cands.length) {
      // preferir la coincidencia exacta de conjunto sobre la de contención
      const exactos = cands.filter((d) => {
        const dt = new Set(tokensNombre(d.nombre ?? ""));
        return dt.size === tokens.length && tokens.every((t) => dt.has(t));
      });
      const d = elegir(exactos.length ? exactos : cands);
      if (d) return { doctor: d, via: "nombre" };
      return { doctor: null, via: "ambiguo", candidatos: cands.map((x) => x.nombre ?? x.id) };
    }
  }
  return { doctor: null, via: "sin_match" };
}

// ---------------------------------------------------------------------------
// Equipo: qué mensajes son "nuestros"
// ---------------------------------------------------------------------------

/** Las líneas de la organización, leídas de WA_LINEAS_KS: teléfonos separados
 *  por coma, en cualquier formato (se canonizan). Un mensaje de Juan en un grupo
 *  cuenta como respondido por KeepSmiling. No viven en el código porque el repo
 *  es público. Sin la variable, "nuestros" son solo los from_me y los nombres
 *  agendados de esDelEquipo. */
export function lineasKS(valor: string | undefined = process.env.WA_LINEAS_KS): string[] {
  return (valor ?? "")
    .split(/[,;]+/)
    .map((t) => canonTel(t))
    .filter((t): t is string => t !== null);
}

export function esDelEquipo(m: Mensaje, lineas: string[] = lineasKS()): boolean {
  if (m.from_me) return true;
  const c = cola10(m.autor_tel);
  if (c && lineas.some((l) => cola10(l) === c)) return true;
  const a = normalizarTexto(m.autor ?? "");
  // nombres con los que WhatsApp muestra a las líneas KS cuando están agendadas
  return /\bkeepsmiling\b|\bkeep smiling\b|\bjuan banffi\b|\brocio puig\b/.test(a);
}

// ---------------------------------------------------------------------------
// Días y transcripciones
// ---------------------------------------------------------------------------

export const ZONA_MX = "America/Mexico_City";

/** YYYY-MM-DD de un instante en una zona (default: México). */
export function diaLocal(iso: string, zona: string = ZONA_MX): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`fecha inválida: ${iso}`);
  // sv-SE da "YYYY-MM-DD HH:mm:ss" — lo más corto para quedarse con la fecha
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function horaLocal(iso: string, zona: string = ZONA_MX): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: zona,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Los mensajes de un chat agrupados por día local, ordenados por hora. */
export function agruparPorDia(mensajes: Mensaje[], zona: string = ZONA_MX): Map<string, Mensaje[]> {
  const out = new Map<string, Mensaje[]>();
  const orden = [...mensajes].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const m of orden) {
    const dia = diaLocal(m.ts, zona);
    const lista = out.get(dia) ?? [];
    lista.push(m);
    out.set(dia, lista);
  }
  return out;
}

/** Saca teléfonos del texto antes de que viaje al modelo (lib/ai/pii.ts). */
export function sinTelefonos(texto: string): string {
  return texto.replace(/\+?\d[\d\s().-]{8,}\d/g, "[tel]");
}

/**
 * Transcripción legible para el modelo. Sin teléfonos; "KS" para lo nuestro y
 * el autor tal cual para el resto (en un grupo puede escribir el doctor o su
 * asistente). Los medios se anotan entre corchetes.
 */
export function transcripcion(mensajes: Mensaje[], opts?: { equipo?: string[]; zona?: string }): string {
  const lineas: string[] = [];
  for (const m of mensajes) {
    const quien = esDelEquipo(m, opts?.equipo) ? "KS" : (m.autor?.trim() || "Doctor");
    const tipo = m.tipo && m.tipo !== "chat" ? `[${m.tipo}] ` : "";
    const texto = (m.texto ?? "").trim();
    if (!texto && !tipo) continue;
    lineas.push(`${horaLocal(m.ts, opts?.zona)} ${quien}: ${tipo}${sinTelefonos(texto)}`.trim());
  }
  return lineas.join("\n");
}

/** Último mensaje por fecha (para wa_conversations.last_message_*). */
export function ultimoMensaje(mensajes: Mensaje[]): Mensaje | null {
  if (!mensajes.length) return null;
  return mensajes.reduce((a, b) => (Date.parse(b.ts) > Date.parse(a.ts) ? b : a));
}

/** Huella de la actividad de un chat+día: la corrida siguiente la reconoce y
 *  regenera el resumen en vez de duplicarla. */
export function syncKeyActividad(linea: string, chatId: string, dia: string): string {
  return `wa:${linea}:${chatId}:${dia}`;
}

// ---------------------------------------------------------------------------
// Resultado y aviso a Slack
// ---------------------------------------------------------------------------

export interface ResultadoChat {
  chat_id: string;
  nombre: string;
  es_grupo: boolean;
  doctor: { id: string; nombre: string } | null;
  via: MatchDoctor["via"];
  candidatos?: string[];
  mensajes_nuevos: number;
  ultimo_es_nuestro: boolean;
  /** Lo que el trigger va a decidir con el último mensaje (aprox. para el aviso). */
  espera_respuesta: boolean;
  resumen: string | null;
  pedidos: { titulo: string; tipo: string; vence: string }[];
  actividad_id?: string | null;
}

export interface ResultadoCorrida {
  linea: string;
  leido_hasta: string;
  chats: ResultadoChat[];
  costo_usd: number;
  dry_run: boolean;
}

const CRM_URL = "https://crm-mx-puce.vercel.app";

export function lineaCorta(linea: string): string {
  return `…${linea.slice(-4)}`;
}

/** El aviso de Slack: corto, con lo que una persona tiene que mirar. */
export function textoAvisoSlack(r: ResultadoCorrida): string {
  const conDoctor = r.chats.filter((c) => c.doctor && c.mensajes_nuevos > 0);
  const esperan = conDoctor.filter((c) => c.espera_respuesta);
  const sinFicha = r.chats.filter((c) => !c.doctor && c.mensajes_nuevos > 0);
  const pedidos = conDoctor.reduce((n, c) => n + c.pedidos.length, 0);
  const fecha = new Intl.DateTimeFormat("es-AR", {
    timeZone: ZONA_MX,
    day: "numeric",
    month: "numeric",
  }).format(new Date(r.leido_hasta));
  const hora = horaLocal(r.leido_hasta);

  const partes: string[] = [];
  partes.push(
    `*WhatsApp directo · línea ${lineaCorta(r.linea)} · ${fecha} (leído hasta ${hora} MX)${r.dry_run ? " · SIMULACIÓN" : ""}*`
  );
  if (!conDoctor.length && !sinFicha.length) {
    partes.push("Sin mensajes nuevos desde la última lectura.");
    return partes.join("\n");
  }
  if (conDoctor.length) {
    partes.push(`*${conDoctor.length} doctor${conDoctor.length === 1 ? "" : "es"} con conversación:*`);
    for (const c of conDoctor.slice(0, 25)) {
      const link = `<${CRM_URL}/doctores/${c.doctor!.id}|${c.doctor!.nombre}>`;
      const flag = c.espera_respuesta ? " ⚠️ espera respuesta" : "";
      const ped = c.pedidos.length ? ` · ${c.pedidos.length} tarea${c.pedidos.length === 1 ? "" : "s"} propuesta${c.pedidos.length === 1 ? "" : "s"}` : "";
      partes.push(`• ${link} — ${c.resumen ?? `${c.mensajes_nuevos} mensajes`}${flag}${ped}`);
    }
    if (conDoctor.length > 25) partes.push(`… y ${conDoctor.length - 25} más en el CRM.`);
  }
  if (esperan.length) {
    partes.push(`*Esperan respuesta nuestra:* ${esperan.length} (en /hoy y /panel).`);
  }
  if (pedidos) {
    partes.push(`*Tareas propuestas:* ${pedidos}, para aprobar en la ficha de cada doctor.`);
  }
  if (sinFicha.length) {
    const nombres = sinFicha.slice(0, 10).map((c) => c.nombre + (c.via === "ambiguo" ? " (2+ fichas posibles)" : ""));
    partes.push(
      `*Sin ficha en el CRM (${sinFicha.length}):* ${nombres.join(", ")}${sinFicha.length > 10 ? "…" : ""}`
    );
  }
  if (r.costo_usd > 0) partes.push(`_IA: USD ${r.costo_usd.toFixed(2)}_`);
  return partes.join("\n");
}

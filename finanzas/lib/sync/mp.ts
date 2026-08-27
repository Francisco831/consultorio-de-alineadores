// Mercado Pago vía API oficial (reporte de liberaciones) → statement_lines.
//
// El extracto CONFIRMA, no duplica: las líneas quedan pending y se concilian en
// /[empresa]/movimientos/conciliar (botón Sugerir). Dedup en dos capas:
//   1. SOURCE_ID contra el op_id de líneas ya importadas a mano (PDF/CSV)
//   2. external_key de contenido (re-correr el mismo rango es no-op)
//
// Extraído de scripts/mp-sync.ts para que lo corra también el cron de Vercel.
// Token: MP_ACCESS_TOKEN_AR / _MX. Cómo generarlo: docs/mercadopago-api.md

import type { SupabaseClient } from "@supabase/supabase-js";
import { KeyBuilder, sha256Hex } from "@/lib/import/keys";
import { parseMpApiCsv } from "@/lib/import/parse-mp-api";
import { fetchAllRows, upsertBatched } from "@/lib/sync/db";

const API = "https://api.mercadopago.com/v1/account/release_report";

export type ResultadoMp = {
  empresa: string;
  cuenta: string;
  desde: string;
  hasta: string;
  leidas: number;
  insertadas: number;
  saltadasPorOpId: number;
  reporte: string;
};

/** Rango vacío: no hay nada que traer (ya se sincronizó hasta hoy). */
export class RangoVacio extends Error {}

/**
 * Qué fecha mandarle a MP para que el reporte caiga en el día que queremos.
 *
 * MP es rígido de las dos puntas, verificado el 27/8/26 contra la API real:
 *   · la hora tiene que ser EXACTAMENTE T00:00:00Z — "…T03:00:00Z" y
 *     "…T00:00:00-03:00" los rechaza igual, con `invalid_begin_date`;
 *   · pero el instante lo interpreta en la zona de la CUENTA y lo redondea al
 *     día, así que medianoche UTC cae a las 21:00 del día ANTERIOR en Argentina.
 *
 * O sea que no hay forma de escribir "medianoche local": hay que elegir el día
 * en Z cuya medianoche cae dentro del día local buscado. Con eso, pedir el 22
 * trae el 22 — y no el 21, que es el que ya está cargado a mano.
 *
 * Se resuelve probando, no con la cuenta del offset: así vale igual para una
 * zona al este de Greenwich, donde el corrimiento va para el otro lado.
 */
export function diaZParaDiaLocal(objetivo: string, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  for (const delta of [0, 1, -1]) {
    const candidato = sumarDias(objetivo, delta);
    if (fmt.format(new Date(`${candidato}T00:00:00Z`)) === objetivo) return candidato;
  }
  return objetivo;
}

/** El offset de la cuenta ese día ("-03:00"), respetando horario de verano. */
export function offsetDe(tz: string, dia: string): string {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${dia}T12:00:00Z`));
  const nombre = partes.find((p) => p.type === "timeZoneName")?.value ?? "";
  return nombre.replace("GMT", "") || "+00:00";   // "GMT-03:00" → "-03:00", "GMT" → "+00:00"
}

/** Suma (o resta) días a una fecha YYYY-MM-DD, sin sorpresas de zona horaria. */
export function sumarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function mp<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const cuerpo = (await res.text()).slice(0, 300);
    throw new Error(`MP ${init?.method ?? "GET"} ${url.replace(API, "…")} → HTTP ${res.status}: ${cuerpo}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}

type Reporte = { id: number; file_name: string; status: string; begin_date: string; end_date: string };

/**
 * Lo que MP tiene hoy en la lista de reportes, crudo y sin tocar nada.
 * Sólo lectura: no genera reportes ni escribe en la base. Existe porque los
 * campos de esta API no son los que dice la documentación —el estado vino como
 * 'enabled' y la fecha de inicio corrida un día— y sin verlo de verdad, "no
 * apareció el reporte" tapa por igual tres causas distintas.
 */
export async function listarReportesMp(token: string): Promise<unknown> {
  return mp<unknown>(token, `${API}/list`);
}

/**
 * Las primeras líneas del reporte más nuevo, sin escribir nada en la base.
 * El CSV de Argentina no trae las mismas columnas que el de México, y sin ver
 * el encabezado real el parser se escribe a ciegas.
 */
export async function muestraReporteMp(token: string, lineas = 4): Promise<unknown> {
  const lista = await mp<Reporte[]>(token, `${API}/list`);
  const r = lista.find((x) => x.file_name);
  if (!r) return { sinReportes: true };
  const csv = await mp<string>(token, `${API}/${r.file_name}`);
  const todas = csv.split(/\r?\n/).filter((l) => l.trim());
  return {
    reporte: r.file_name,
    rango: `${r.begin_date} → ${r.end_date}`,
    totalLineas: todas.length,
    primeras: todas.slice(0, lineas),
    ultimas: todas.slice(-lineas),   // el cierre importa: de ahí sale el saldo final
  };
}

export async function sincronizarMp(
  db: SupabaseClient,
  opts: {
    empresa: "ar" | "mx";
    token: string;
    desde?: string;
    hasta?: string;
    /** Cuántas vueltas de 5s esperar a que MP procese el reporte. */
    intentos?: number;
    dryRun?: boolean;
    log?: (m: string) => void;
  }
): Promise<ResultadoMp> {
  const log = opts.log ?? (() => {});
  const { empresa, token } = opts;

  const { data: cia } = await db.from("companies").select("id, timezone").eq("slug", empresa).single();
  if (!cia) throw new Error(`empresa '${empresa}' inexistente`);
  const { data: cuenta } = await db.from("accounts").select("id, name, currency")
    .eq("company_id", cia.id).eq("type", "mercadopago").single();
  if (!cuenta) throw new Error(`no hay cuenta type=mercadopago en ${empresa}`);

  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: cia.timezone }).format(new Date());
  let desdeCalc = opts.desde;
  if (!desdeCalc) {
    const { data: ult } = await db.from("sync_runs").select("watermark")
      .eq("company_id", cia.id).eq("source", `mp_api_${empresa}`).eq("status", "ok")
      .order("watermark", { ascending: false }).limit(1).maybeSingle();
    desdeCalc = (ult?.watermark as string | null)?.slice(0, 10);
    if (!desdeCalc) {
      // PRIMERA corrida: no arrancar ciego el 1 del mes. El extracto puede venir
      // sembrado a mano y las dos capas de dedup no lo ven — las líneas de AR se
      // cargaron con clave 'mpmanual:' y SIN op_id, así que ni la clave de
      // contenido ni el SOURCE_ID las reconocen, y volverían a entrar duplicadas.
      // El piso es el día siguiente a la última línea que ya tiene la cuenta.
      const { data: ultLinea } = await db.from("statement_lines").select("posted_on")
        .eq("company_id", cia.id).eq("account_id", cuenta.id)
        .order("posted_on", { ascending: false }).limit(1).maybeSingle();
      const cargado = ultLinea?.posted_on as string | undefined;
      if (cargado) {
        const d = new Date(`${cargado}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        desdeCalc = d.toISOString().slice(0, 10);
        log(`Primera corrida: la cuenta ya tiene extracto hasta ${cargado}, arranco el ${desdeCalc}`);
      } else {
        desdeCalc = `${hoy.slice(0, 7)}-01`;
      }
    }
  }
  const desde: string = desdeCalc;
  const hasta = opts.hasta ?? hoy;
  if (desde >= hasta) throw new RangoVacio(`rango vacío [${desde}, ${hasta}) — nada que traer`);
  log(`Cuenta ${cuenta.name} (${cuenta.currency}) · rango [${desde}, ${hasta})`);

  // 1. generar el reporte (asincrónico del lado de MP)
  //
  // Las fechas pasan por diaZParaDiaLocal: MP las interpreta en la zona de la
  // cuenta, así que el día que se manda no es el día que se pide. El fin va en
  // `hasta` menos uno porque MP lo extiende al final de ese día en la cuenta,
  // que es exactamente el borde exclusivo que queremos.
  const finInclusivo = sumarDias(hasta, -1);
  // La respuesta del POST se USA: si trae el reporte que acaba de crear, lo
  // buscamos por id y nos olvidamos de adivinar por fechas (que es donde esto
  // venía fallando). Antes se descartaba, y con ella la única pista de por qué
  // MP a veces acepta el pedido y no genera nada.
  const creado = await mp<Partial<Reporte> | null>(token, API, {
    method: "POST",
    body: JSON.stringify({
      begin_date: `${diaZParaDiaLocal(desde, cia.timezone)}T00:00:00Z`,
      end_date: `${diaZParaDiaLocal(finInclusivo, cia.timezone)}T00:00:00Z`,
    }),
  });
  const idCreado = creado?.id;
  log(`MP respondió al pedido: ${JSON.stringify(creado ?? null).slice(0, 200)}`);

  // 2. esperar a que aparezca procesado en la lista
  const intentos = opts.intentos ?? 24;
  let reporte: Reporte | undefined;
  let ultimaLista: Reporte[] = [];
  const diaLocal = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: cia.timezone }).format(new Date(iso));
  for (let i = 0; i < intentos && !reporte; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    ultimaLista = await mp<Reporte[]>(token, `${API}/list`);
    // Las fechas de la lista se comparan como DÍAS de la cuenta, no como texto
    // ISO: MP las devuelve como instantes UTC del día local (03:00Z / 02:59Z).
    // Y 'enabled' es el estado en que MP deja un reporte listo para bajar —
    // no está en ninguna de las listas de estados que decía el código viejo.
    // De los que empatan vale el más nuevo: cada reintento generó el suyo.
    const listo = (r: Reporte) =>
      r.file_name && ["processed", "available", "done", "enabled"].includes(r.status);
    reporte =
      (idCreado ? ultimaLista.find((r) => r.id === idCreado && listo(r)) : undefined) ??
      [...ultimaLista].reverse().find((r) =>
        listo(r) && diaLocal(r.begin_date) === desde && diaLocal(r.end_date) === finInclusivo);
  }
  if (!reporte) {
    // Qué SÍ devolvió MP. Sin esto, "no apareció" tapa por igual tres causas
    // distintas: que todavía esté procesando, que las fechas no coincidan como
    // esperamos, o que el estado venga con un nombre que no conocemos.
    const vistos = ultimaLista.slice(0, 6).map((r) =>
      `${r.begin_date?.slice(0, 10)}→${r.end_date?.slice(0, 10)} [${r.status}]`).join(" · ");
    throw new Error(
      `el reporte [${desde}, ${hasta}) no apareció procesado tras ` +
      `${Math.round(intentos * 5 / 60)} minuto(s). MP listó ${ultimaLista.length}: ${vistos || "(ninguno)"}`
    );
  }

  // 3. bajar y parsear
  const csv = await mp<string>(token, `${API}/${reporte.file_name}`);
  const { movimientos, control } = parseMpApiCsv(csv);
  log(`Reporte ${reporte.file_name}: ${movimientos.length} movimientos · ` +
    `saldo disponible inicial ${control.inicial ?? "?"} → final ${control.final ?? "?"}`);

  // 4. dedup capa 1: SOURCE_ID contra op_id de líneas ya importadas a mano
  const existentes = await fetchAllRows<{ raw: { op_id?: string | null } | null }>(
    db, "statement_lines", "raw",
    (q) => q.eq("company_id", cia.id).eq("account_id", cuenta.id)
            .gte("posted_on", desde).lt("posted_on", hasta));
  const opIds = new Set(existentes.map((l) => l.raw?.op_id).filter(Boolean) as string[]);
  const nuevas = movimientos.filter((m) => !m.source_id || !opIds.has(m.source_id));
  const saltadas = movimientos.length - nuevas.length;
  if (saltadas) log(`${saltadas} ya estaban por import manual (mismo SOURCE_ID) — se saltean`);

  if (opts.dryRun) {
    log(`DRY-RUN: se cargarían ${nuevas.length} líneas.`);
    for (const m of nuevas.slice(0, 10)) {
      log(`  ${m.fecha}  ${m.monto >= 0 ? "+" : ""}${m.monto}  ${m.descripcion.slice(0, 60)}`);
    }
    if (nuevas.length > 10) log(`  … y ${nuevas.length - 10} más`);
    return {
      empresa, cuenta: cuenta.name, desde, hasta,
      leidas: movimientos.length, insertadas: 0, saltadasPorOpId: saltadas, reporte: reporte.file_name,
    };
  }

  const inicio = new Date().toISOString();
  const sha = sha256Hex(csv);
  const { data: exB } = await db.from("import_batches").select("id")
    .eq("company_id", cia.id).eq("account_id", cuenta.id).eq("file_sha256", sha).maybeSingle();
  let batchId = exB?.id;
  if (!batchId) {
    const { data: b, error } = await db.from("import_batches").insert({
      // 'mp_api' NO existe: import_batches tiene un CHECK (migración 0006) que
      // sólo acepta bbva|macro|mp_mx|mp_ar|caja|csv|xlsx|seed. Con el valor
      // viejo, TODA corrida moría acá — el script nunca se había corrido con
      // --apply, así que nadie lo había visto.
      company_id: cia.id, account_id: cuenta.id, source: `mp_${empresa}`,
      filename: reporte.file_name, file_sha256: sha,
      period_from: desde, period_to: hasta, status: "processing",
    }).select("id").single();
    if (error) throw new Error(`batch: ${error.message}`);
    batchId = b.id;
  }

  const keys = new KeyBuilder();
  const filas = nuevas.map((m, i) => ({
    company_id: cia.id, batch_id: batchId, account_id: cuenta.id,
    line_no: i + 1, posted_on: m.fecha,
    description_raw: m.descripcion.slice(0, 500), counterparty_raw: null,
    amount: m.monto, currency: cuenta.currency,
    external_key: keys.build("mpapi", m.fecha, m.monto, m.descripcion, m.source_id ?? ""),
    match_status: "pending", raw: { op_id: m.source_id, reporte: reporte!.file_name },
  }));
  const { count: antes } = await db.from("statement_lines").select("id", { count: "exact", head: true })
    .eq("company_id", cia.id).eq("account_id", cuenta.id);
  await upsertBatched(db, "statement_lines", filas, "company_id,account_id,external_key", { ignoreDuplicates: true });
  const { count: despues } = await db.from("statement_lines").select("id", { count: "exact", head: true })
    .eq("company_id", cia.id).eq("account_id", cuenta.id);
  const insertadas = (despues ?? 0) - (antes ?? 0);

  await db.from("import_batches").update({
    status: "done", stats: { lineas: filas.length, insertadas, saltadas_por_op_id: saltadas, control },
  }).eq("id", batchId);
  await db.from("sync_runs").insert({
    company_id: cia.id, source: `mp_api_${empresa}`, started_at: inicio,
    finished_at: new Date().toISOString(), rows_read: movimientos.length,
    rows_upserted: insertadas, watermark: `${hasta}T00:00:00Z`, status: "ok",
    log: { desde, hasta, reporte: reporte.file_name, saltadas_por_op_id: saltadas },
  });

  log(`${insertadas} líneas nuevas (${filas.length - insertadas} ya existían por clave).`);
  return {
    empresa, cuenta: cuenta.name, desde, hasta,
    leidas: movimientos.length, insertadas, saltadasPorOpId: saltadas, reporte: reporte.file_name,
  };
}

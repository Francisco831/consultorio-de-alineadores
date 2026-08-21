// Sync de movimientos de Mercado Pago vía API oficial (reporte de liberaciones).
// Genera el reporte para un rango, lo baja y carga statement_lines — el
// extracto CONFIRMA, no duplica: las líneas quedan pending y se concilian en
// /[empresa]/movimientos/conciliar (botón Sugerir). Dedup en dos capas:
//   1. SOURCE_ID contra el op_id de líneas ya importadas a mano (PDF/CSV)
//   2. external_key de contenido (re-correr el mismo rango es no-op)
//
// Requiere token en .env.local: MP_ACCESS_TOKEN_MX (o _AR).
// Cómo generarlo: docs/mercadopago-api.md
//
// Uso:  npx tsx scripts/mp-sync.ts --empresa mx [--desde 2026-08-01] [--hasta 2026-08-21]
//       npx tsx scripts/mp-sync.ts --empresa mx --apply
// Rango: [desde, hasta) — hasta excluido; default desde = watermark del último
// sync ok (o día 1 del mes), default hasta = hoy.

import { KeyBuilder, sha256Hex } from "../lib/import/keys";
import { parseMpApiCsv } from "../lib/import/parse-mp-api";
import { serviceClient, upsertBatched, fetchAllRows, argFlags } from "./lib/service-client";

const API = "https://api.mercadopago.com/v1/account/release_report";

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function mp<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const cuerpo = (await res.text()).slice(0, 300);
    throw new Error(`MP ${init?.method ?? "GET"} ${url.replace(API, "…")} → HTTP ${res.status}: ${cuerpo}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}

type Reporte = { id: number; file_name: string; status: string; begin_date: string; end_date: string; created_from?: string };

async function main() {
  const flags = argFlags();
  const empresa = (argValor("empresa") ?? "mx") as "mx" | "ar";
  if (!["mx", "ar"].includes(empresa)) throw new Error("--empresa debe ser mx o ar");

  const token = process.env[`MP_ACCESS_TOKEN_${empresa.toUpperCase()}`];
  if (!token) {
    console.error(
      `Falta MP_ACCESS_TOKEN_${empresa.toUpperCase()} en .env.local.\n` +
      `Cómo crear el token (panel de desarrolladores de MP): docs/mercadopago-api.md`
    );
    process.exit(1);
  }

  const db = await serviceClient({
    accion: `sync Mercado Pago ${empresa.toUpperCase()} vía API (reporte de liberaciones)`,
    auto: flags.yes,
  });
  const { data: cia } = await db.from("companies").select("id, timezone").eq("slug", empresa).single();
  if (!cia) throw new Error(`empresa '${empresa}' inexistente`);
  const { data: cuenta } = await db.from("accounts").select("id, name, currency")
    .eq("company_id", cia.id).eq("type", "mercadopago").single();
  if (!cuenta) throw new Error(`no hay cuenta type=mercadopago en ${empresa}`);

  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: cia.timezone }).format(new Date());
  let desde: string;
  const desdeArg = argValor("desde");
  if (desdeArg) {
    desde = desdeArg;
  } else {
    const { data: ult } = await db.from("sync_runs").select("watermark")
      .eq("company_id", cia.id).eq("source", `mp_api_${empresa}`).eq("status", "ok")
      .order("watermark", { ascending: false }).limit(1).maybeSingle();
    desde = ult?.watermark?.slice(0, 10) ?? `${hoy.slice(0, 7)}-01`;
  }
  const hasta = argValor("hasta") ?? hoy;
  if (desde >= hasta) { console.log(`Rango vacío [${desde}, ${hasta}) — nada que traer.`); return; }
  console.log(`Cuenta ${cuenta.name} (${cuenta.currency}) · rango [${desde}, ${hasta})`);

  // 1. generar el reporte (asincrónico del lado de MP)
  await mp(token, API, {
    method: "POST",
    body: JSON.stringify({ begin_date: `${desde}T00:00:00Z`, end_date: `${hasta}T00:00:00Z` }),
  });

  // 2. esperar a que aparezca procesado en la lista
  let reporte: Reporte | undefined;
  for (let i = 0; i < 24 && !reporte; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const lista = await mp<Reporte[]>(token, `${API}/list`);
    reporte = lista.find((r) =>
      r.begin_date.slice(0, 10) === desde && r.end_date.slice(0, 10) === hasta &&
      ["processed", "available", "done"].includes(r.status));
  }
  if (!reporte) throw new Error("el reporte no apareció procesado tras 2 minutos — reintentar en un rato");

  // 3. bajar y parsear
  const csv = await mp<string>(token, `${API}/${reporte.file_name}`);
  const { movimientos, control } = parseMpApiCsv(csv);
  console.log(`Reporte ${reporte.file_name}: ${movimientos.length} movimientos · ` +
    `saldo disponible inicial ${control.inicial ?? "?"} → final ${control.final ?? "?"}`);

  // 4. dedup capa 1: SOURCE_ID contra op_id de líneas ya importadas a mano
  const existentes = await fetchAllRows<{ raw: { op_id?: string | null } | null }>(
    db, "statement_lines", "raw",
    (q) => q.eq("company_id", cia.id).eq("account_id", cuenta.id)
            .gte("posted_on", desde).lt("posted_on", hasta));
  const opIds = new Set(existentes.map((l) => l.raw?.op_id).filter(Boolean) as string[]);
  const nuevas = movimientos.filter((m) => !m.source_id || !opIds.has(m.source_id));
  const saltadas = movimientos.length - nuevas.length;
  if (saltadas) console.log(`  ${saltadas} ya estaban por import manual (mismo SOURCE_ID) — se saltean`);

  if (flags.dryRun) {
    console.log(`DRY-RUN (sin --apply no escribe). Se cargarían ${nuevas.length} líneas.`);
    for (const m of nuevas.slice(0, 10)) console.log(`  ${m.fecha}  ${m.monto >= 0 ? "+" : ""}${m.monto}  ${m.descripcion.slice(0, 60)}`);
    if (nuevas.length > 10) console.log(`  … y ${nuevas.length - 10} más`);
    return;
  }

  const inicio = new Date().toISOString();
  const sha = sha256Hex(csv);
  const { data: exB } = await db.from("import_batches").select("id")
    .eq("company_id", cia.id).eq("account_id", cuenta.id).eq("file_sha256", sha).maybeSingle();
  let batchId = exB?.id;
  if (!batchId) {
    const { data: b, error } = await db.from("import_batches").insert({
      company_id: cia.id, account_id: cuenta.id, source: "mp_api",
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

  console.log(`Listo: ${insertadas} líneas nuevas (${filas.length - insertadas} ya existían por clave). ` +
    `Conciliar en /${empresa}/movimientos/conciliar → Sugerir.`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

/**
 * Respaldo diario de los datos del CRM a Supabase Storage (bucket privado
 * `respaldos`). Corre en Vercel (cron /api/ops/respaldo) con service role: no
 * depende de ninguna máquina, ni de un secreto que no esté ya en Vercel.
 *
 * QUÉ GUARDA. Cada tabla de `public` a `<fecha>/<tabla>.ndjson.gz` (una fila
 * por línea, mismo formato que scripts/backup-datos.ts, así que
 * scripts/restaurar-datos.ts lo carga tal cual después de bajarlo con
 * scripts/bajar-respaldo.ts), más `auth.users.ndjson.gz` con las cuentas
 * (id, email, metadata — SIN hash de contraseña: la API de admin no lo expone;
 * el volcado con hash es el de GitHub Actions, que va por Postgres directo) y
 * un `manifiesto.json` con los conteos y las migraciones aplicadas.
 *
 * QUÉ NO ES. No es point-in-time recovery: es una foto diaria. Contra un
 * borrado accidental a las 16:00 se pierde lo del día. Para PITR el camino es
 * el plan Pro de Supabase. Tampoco guarda el schema: el schema son las
 * migraciones del repo, y el manifiesto dice hasta cuál estaba aplicada.
 *
 * RETENCIÓN. Se borran las carpetas de más de RETENCION_DIAS. Con ~8 MB por día
 * entra holgado en el 1 GB del plan Free.
 */
import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";

export const BUCKET = "respaldos";
export const RETENCION_DIAS = 30;
const PAGINA = 1000;

export interface ResumenRespaldo {
  carpeta: string;
  tablas: Record<string, number>;
  filas: number;
  bytes: number;
  borradas: string[];
  avisos: string[];
}

/**
 * Las tablas de `public`, escritas a mano y no consultadas al catálogo.
 *
 * PostgREST no puede listar tablas sin una función que se lo pida a Postgres, y
 * agregar una RPC para esto significa que el respaldo depende de una migración
 * aplicada. Preferimos la lista acá y un test que la compara contra
 * supabase/migrations: si alguien crea una tabla y se olvida de sumarla, el test
 * falla en CI. Un respaldo que se saltea una tabla en silencio es peor que uno
 * que no corre.
 */
export const TABLAS_RESPALDO = [
  "activities", "agent_handoffs", "agent_runs", "ai_recommendations",
  "alerta_rechazos_estado", "alerts", "audit_log", "auth_allowlist",
  "automation_rules", "calendar_events", "campaigns", "cases",
  "cohort_intervals", "commercial_offers", "contacts", "custom_field_defs",
  "doctor_ai_profile", "doctors", "event_attendees", "events", "goals",
  "opportunities", "payments", "pendientes", "profiles", "saved_views",
  "score_snapshots", "segments", "sync_runs", "tasks", "wa_conversations",
  "wa_messages",
] as const;

/**
 * Trae TODAS las filas de una tabla (PostgREST corta en 1.000 y no avisa).
 *
 * Ordena por `id` para que la paginación sea estable: sin ORDER BY, Postgres no
 * garantiza el mismo orden entre páginas y un respaldo puede repetir una fila y
 * saltearse otra. Las pocas tablas cuya clave no es `id` (cohort_intervals,
 * alerta_rechazos_estado) caen al camino sin orden, que a su tamaño es seguro.
 */
async function filasDe(db: SupabaseClient, tabla: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let ordenar = true;
  for (let desde = 0; ; desde += PAGINA) {
    let q = db.from(tabla).select("*").range(desde, desde + PAGINA - 1);
    if (ordenar) q = q.order("id", { ascending: true });
    const { data, error } = await q;
    if (error) {
      // 42703 = la tabla no tiene columna `id`: se reintenta sin orden.
      if (ordenar && (error.code === "42703" || /column .*id.* does not exist/i.test(error.message))) {
        ordenar = false;
        desde -= PAGINA;
        continue;
      }
      throw new Error(`${tabla}: ${error.message}`);
    }
    const filas = data ?? [];
    out.push(...filas);
    if (filas.length < PAGINA) break;
  }
  return out;
}

function ndjsonGz(filas: unknown[]): Buffer {
  return gzipSync(Buffer.from(filas.map((f) => JSON.stringify(f)).join("\n") + (filas.length ? "\n" : ""), "utf8"));
}

async function subir(db: SupabaseClient, ruta: string, cuerpo: Buffer, contentType: string): Promise<number> {
  const { error } = await db.storage.from(BUCKET).upload(ruta, cuerpo, { contentType, upsert: true });
  if (error) throw new Error(`storage ${ruta}: ${error.message}`);
  return cuerpo.byteLength;
}

async function asegurarBucket(db: SupabaseClient): Promise<void> {
  const { data } = await db.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await db.storage.createBucket(BUCKET, { public: false });
  // dos crons a la vez: si el otro lo creó primero, listo
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(`no se pudo crear el bucket ${BUCKET}: ${error.message}`);
  }
}

/** Borra las carpetas (YYYY-MM-DD…) más viejas que la retención. */
async function podar(db: SupabaseClient, hoyISO: string): Promise<string[]> {
  const { data: carpetas, error } = await db.storage.from(BUCKET).list("", { limit: 1000 });
  if (error) throw new Error(`storage list: ${error.message}`);
  const limite = new Date(`${hoyISO}T00:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() - RETENCION_DIAS);
  const borradas: string[] = [];
  for (const c of carpetas ?? []) {
    const m = c.name.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m || new Date(`${m[1]}T00:00:00Z`) >= limite) continue;
    const { data: archivos } = await db.storage.from(BUCKET).list(c.name, { limit: 1000 });
    const rutas = (archivos ?? []).map((a) => `${c.name}/${a.name}`);
    if (rutas.length) {
      const { error: e } = await db.storage.from(BUCKET).remove(rutas);
      if (e) throw new Error(`storage remove ${c.name}: ${e.message}`);
    }
    borradas.push(c.name);
  }
  return borradas;
}

export async function correrRespaldo(
  db: SupabaseClient,
  sello: string,
  log: (s: string) => void
): Promise<ResumenRespaldo> {
  await asegurarBucket(db);
  const carpeta = sello; // YYYY-MM-DDTHH-MM (UTC)
  const conteos: Record<string, number> = {};
  const avisos: string[] = [];
  let bytes = 0;

  for (const tabla of TABLAS_RESPALDO) {
    const filas = await filasDe(db, tabla);
    conteos[tabla] = filas.length;
    bytes += await subir(db, `${carpeta}/${tabla}.ndjson.gz`, ndjsonGz(filas), "application/gzip");
    log(`${tabla}: ${filas.length}`);
  }

  // Las cuentas, sin hash de contraseña (la API de admin no lo da).
  try {
    const usuarios: unknown[] = [];
    for (let page = 1; ; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      usuarios.push(
        ...data.users.map((u) => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at,
          app_metadata: u.app_metadata,
          user_metadata: u.user_metadata,
        }))
      );
      if (data.users.length < 200) break;
    }
    conteos["auth.users"] = usuarios.length;
    bytes += await subir(db, `${carpeta}/auth.users.ndjson.gz`, ndjsonGz(usuarios), "application/gzip");
  } catch (e) {
    avisos.push(`auth.users no se volcó: ${(e as Error).message}`);
  }

  const filas = Object.values(conteos).reduce((a, b) => a + b, 0);
  const manifiesto = {
    project_ref: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^https?:\/\//, "").split(".")[0],
    fecha: new Date().toISOString(),
    origen: "vercel-cron",
    tablas: conteos,
    filas_totales: filas,
    // El ledger vive en el schema `ops`, que PostgREST no expone: desde acá no se
    // puede leer. Con qué schema restaurar lo dice el respaldo de GitHub Actions
    // (va por Postgres directo) o `db-migrate --check-connection`.
    migraciones_aplicadas: null,
    nota:
      "Volcado de DATOS a Storage, hecho por el cron de Vercel. Para restaurar: bajar la " +
      "carpeta, descomprimir los .gz y cargar con scripts/restaurar-datos.ts. Las cuentas " +
      "van SIN hash de contraseña (la API de admin no lo expone): en una base nueva hay que " +
      "resetear contraseñas, o usar el respaldo de GitHub Actions, que sí lo trae.",
  };
  bytes += await subir(
    db,
    `${carpeta}/manifiesto.json`,
    Buffer.from(JSON.stringify(manifiesto, null, 2), "utf8"),
    "application/json"
  );

  const borradas = await podar(db, sello.slice(0, 10));
  return { carpeta, tablas: conteos, filas, bytes, borradas, avisos };
}

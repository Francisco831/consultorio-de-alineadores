/**
 * Reconcilia los pagos del ledger SIN match en Noloco (doctor_id null):
 * doctores que PAGARON casos pero no existen en el portal comercial.
 *
 *  - matchea el nombre crudo del ledger contra TODOS los doctores del CRM
 *    (incluidos los prospectos recién cargados: varios "prospectos" ya pagaron)
 *  - match no acreditado → is_accredited=true (pagó = cliente) + linkea pagos
 *  - sin match → crea el doctor como acreditado/activado (tag ledger-sin-noloco)
 *  - recompute de los afectados
 *
 *   SUPABASE_DB_HOST=… SUPABASE_PROJECT_REF=… npx tsx scripts/reconcile-ledger.ts
 */
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const ref =
  process.env.SUPABASE_PROJECT_REF ??
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace("https://", "").split(".")[0];
const host = process.env.SUPABASE_DB_HOST ?? "aws-0-ca-central-1.pooler.supabase.com";

const TITLES = /\b(dra?|drs|doctora?|od|cd|mtra?|esp|lic)\b\.?/g;
function nameTokens(s: string): string[] {
  return [
    ...new Set(
      s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(TITLES, " ")
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !["de", "del", "la", "las", "los", "y"].includes(t))
    ),
  ].sort();
}
/** 3 tokens en común (o dos nombres cortos idénticos). Con 2 tokens se fusionan
 *  personas distintas — y acá el daño sería peor: colgarle pagos ajenos a un
 *  doctor y marcarlo acreditado sin serlo. */
function nameMatches(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const inter = a.filter((t) => b.includes(t)).length;
  const small = Math.min(a.length, b.length);
  if (small <= 2) return a.length === b.length && inter === a.length;
  return inter >= 3 && inter >= small - 1;
}
function cleanName(raw: string): string {
  return raw
    .replace(/^\s*(dra?|dr|doctora?)\s*\.?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Pago {
  external_key: string;
  doctor_nombre_raw: string;
  noloco_id: string | null;
  paid_at: string;
  amount_mxn: number | null;
}

async function main() {
  await confirmarDestino({
    accion: "reconciliar el ledger de pagos contra los doctores (vincula y puede crear fichas)",
    refEfectivo: ref,
    auto: process.argv.includes("--yes"),
  });
  const pagos: Pago[] = JSON.parse(
    readFileSync(resolve(__dirname, "../data/payments.json"), "utf8")
  );
  const sinMatch = pagos.filter((p) => !p.noloco_id && p.doctor_nombre_raw);
  const grupos = new Map<string, Pago[]>();
  for (const p of sinMatch) {
    const k = nameTokens(p.doctor_nombre_raw).join(" ");
    grupos.set(k, [...(grupos.get(k) ?? []), p]);
  }
  console.log(`pagos sin doctor: ${sinMatch.length} en ${grupos.size} doctores`);

  const db = new Client({
    host,
    port: 5432,
    database: "postgres",
    user: host.startsWith("db.") ? "postgres" : `postgres.${ref}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await db.connect();
  console.log(`✓ conectado (${ref})`);

  const { rows: doctors } = await db.query(
    `select id, nombre, is_accredited from doctors`
  );
  const withToks = doctors.map((d: any) => ({ toks: nameTokens(d.nombre), d }));

  let linked = 0, created = 0, accredited = 0;
  const touched = new Set<string>();

  for (const [, rows] of grupos) {
    const raw = rows[0].doctor_nombre_raw;
    const toks = nameTokens(raw);
    // si hay más de un candidato, no adivinar: se crea el doctor del ledger
    const cands = withToks.filter((w) => nameMatches(toks, w.toks));
    if (cands.length > 1)
      console.log(
        `  ? "${raw}" matchea ${cands.length} doctores — se crea uno nuevo en vez de adivinar`
      );
    let doc = cands.length === 1 ? cands[0].d : null;

    if (!doc) {
      const { rows: ins } = await db.query(
        `insert into doctors (nombre, is_accredited, lifecycle_stage, tags, is_demo)
         values ($1, true, 'activado', array['ledger-sin-noloco'], false)
         returning id, nombre`,
        [cleanName(raw)]
      );
      doc = { ...ins[0], is_accredited: true };
      withToks.push({ toks, d: doc });
      created++;
      console.log(`  + creado: ${doc.nombre} (${rows.length} pagos)`);
    } else if (!doc.is_accredited) {
      await db.query(`update doctors set is_accredited = true where id = $1`, [doc.id]);
      doc.is_accredited = true;
      accredited++;
      console.log(`  ✓ ${doc.nombre}: era "prospecto" pero PAGÓ — marcado acreditado`);
    }

    const keys = rows.map((r) => r.external_key);
    const { rowCount } = await db.query(
      `update payments set doctor_id = $1
       where external_key = any($2) and doctor_id is null`,
      [doc.id, keys]
    );
    linked += rowCount ?? 0;
    touched.add(doc.id);
  }

  for (const id of touched) {
    await db.query(`select recompute_doctor($1)`, [id]);
  }

  await db.query(
    `insert into sync_runs (source, started_at, finished_at, rows_upserted, status, log)
     values ('ledger_reconcile', now(), now(), $1, 'ok', $2)`,
    [linked, JSON.stringify({ created, accredited_upgrades: accredited })]
  );
  await db.end();
  console.log(
    `\npagos linkeados: ${linked} · doctores creados: ${created} · prospectos→acreditados: ${accredited} · recompute: ${touched.size} ✓`
  );
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Reconcile falló:", e);
  process.exit(1);
});

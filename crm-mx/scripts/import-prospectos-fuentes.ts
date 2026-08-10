/**
 * Carga el universo A (doctores por acreditar) desde data/prospectos_fuentes.json
 * al CRM, vía CONEXIÓN DIRECTA a Postgres (bulk + triggers off + recompute final).
 *
 *  - cada evento (curso/congreso/meeting) = una campaña
 *  - dedupe contra doctores existentes por teléfono canónico / email / nombre
 *  - ya acreditado  → fill-empty + tag del evento (ROI del congreso)
 *  - prospecto ya cargado → enriquecer (interés, competidor, etapa)
 *  - nuevo → doctor lifecycle contactado|prospecto + nota de outreach en timeline
 *  - emails ClearCorrect → etiqueta competidor por email
 *
 * Idempotente: segunda corrida matchea todo y no duplica.
 *
 *   SUPABASE_DB_HOST=aws-0-ca-central-1.pooler.supabase.com \
 *   SUPABASE_PROJECT_REF=<ref> npx tsx scripts/import-prospectos-fuentes.ts
 */
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

const ref =
  process.env.SUPABASE_PROJECT_REF ??
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace("https://", "").split(".")[0];
const host = process.env.SUPABASE_DB_HOST ?? "aws-0-ca-central-1.pooler.supabase.com";
const password = process.env.SUPABASE_DB_PASSWORD!;

interface Person {
  nombre: string;
  phone: string | null;
  email: string | null;
  ciudad: string | null;
  estado: string | null;
  evento: string | null;
  fecha_evento: string | null;
  fuente: string;
  competidor: string | null;
  casos_anio_competidor: number | null;
  nota: string | null;
  warm: boolean;
  fecha_contacto: string | null;
  interesado: boolean;
}

const SOURCE_MAP: Record<string, string> = {
  congreso: "congreso",
  curso: "curso",
  evento: "evento",
  "b-learning": "curso",
  universidad: "universidad",
  competidor: "ventas",
  outbound: "ventas",
};

function canonPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (d.startsWith("521") && d.length === 13) d = "52" + d.slice(3);
  if (d.length === 10) d = "52" + d;
  return d || null;
}

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

/**
 * ¿Son la misma persona por nombre?
 *
 * OJO: dos tokens NO alcanzan. "Ana Flores" comparte 2 tokens con
 * "Ana Karen Ramirez Flores" y son personas distintas (teléfonos distintos).
 * Con 7.000 nombres eso fusionaba ~500 doctores reales que después no existían.
 * Regla: 3 tokens en común, salvo que ambos nombres tengan 2 y sean idénticos.
 */
function nameMatches(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const inter = a.filter((t) => b.includes(t)).length;
  const small = Math.min(a.length, b.length);
  if (small <= 2) {
    // nombres cortos: solo si son exactamente el mismo conjunto
    return a.length === b.length && inter === a.length;
  }
  return inter >= 3 && inter >= small - 1;
}

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

async function main() {
  const people: Person[] = JSON.parse(
    readFileSync(resolve(__dirname, "../data/prospectos_fuentes.json"), "utf8")
  );
  let ccEmails: string[] = [];
  try {
    ccEmails = JSON.parse(
      readFileSync(resolve(__dirname, "../data/clearcorrect_emails.json"), "utf8")
    );
  } catch {}

  const db = new Client({
    host,
    port: 5432,
    database: "postgres",
    user: host.startsWith("db.") ? "postgres" : `postgres.${ref}`,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await db.connect();
  console.log(`✓ conectado (${ref} via ${host})`);

  // ---------- doctores existentes ----------
  const { rows: existing } = await db.query(
    `select id, nombre, phone, whatsapp, email, is_accredited, accredited_at,
            city, source, tags, competitor_brands, interest_level,
            estimated_cases_month, uses_aligners, acquisition_stage, campaign_id
     from doctors`
  );
  const byPhone = new Map<string, any>();
  const byEmail = new Map<string, any>();
  const withTokens: { toks: string[]; d: any }[] = [];
  for (const d of existing) {
    for (const p of [d.phone, d.whatsapp]) {
      const c = canonPhone(p);
      if (c && !byPhone.has(c)) byPhone.set(c, d);
    }
    if (d.email) byEmail.set(String(d.email).toLowerCase(), d);
    withTokens.push({ toks: nameTokens(d.nombre), d });
  }
  const findExisting = (p: Person) => {
    const c = canonPhone(p.phone);
    if (c && byPhone.has(c)) return byPhone.get(c);
    if (p.email && byEmail.has(p.email)) return byEmail.get(p.email);
    const toks = nameTokens(p.nombre);
    const candidatos = withTokens.filter(({ toks: t }) => nameMatches(toks, t));
    // teléfonos distintos ⇒ personas distintas, por más que el nombre coincida
    const compatibles = candidatos.filter(({ d }) => {
      if (!c) return true;
      const dp = canonPhone(d.phone) ?? canonPhone(d.whatsapp);
      return !dp || dp === c;
    });
    // ambigüedad (2+ candidatos) ⇒ no adivinar: entra como prospecto nuevo
    return compatibles.length === 1 ? compatibles[0].d : null;
  };

  // ---------- campañas por evento ----------
  const eventos = new Map<string, { fecha: string | null; tipo: string }>();
  for (const p of people)
    if (p.evento && !eventos.has(p.evento))
      eventos.set(p.evento, { fecha: p.fecha_evento, tipo: p.fuente });
  const campId = new Map<string, string>();
  for (const [nombre, meta] of eventos) {
    const tipo = SOURCE_MAP[meta.tipo] ?? "evento";
    const { rows } = await db.query(
      `insert into campaigns (nombre, tipo, starts_on)
       values ($1, $2::attribution_source, $3)
       on conflict do nothing returning id`,
      [nombre, tipo, meta.fecha]
    );
    if (rows.length) campId.set(nombre, rows[0].id);
    else {
      const { rows: r2 } = await db.query(
        `select id from campaigns where nombre = $1 limit 1`,
        [nombre]
      );
      if (r2.length) campId.set(nombre, r2[0].id);
    }
  }
  console.log(`campañas: ${campId.size}`);

  // ---------- clasificación ----------
  type Stat = { total: number; ya_acred: number; acred_post: number; enriquecidos: number; nuevos: number };
  const porEvento = new Map<string, Stat>();
  const porFuente = new Map<string, Stat>();
  const stat = (m: Map<string, Stat>, k: string): Stat => {
    if (!m.has(k)) m.set(k, { total: 0, ya_acred: 0, acred_post: 0, enriquecidos: 0, nuevos: 0 });
    return m.get(k)!;
  };

  const inserts: any[][] = [];
  const notas: { doctorKey: string; nota: string; fecha: string | null }[] = [];
  const updates: { id: string; sets: string[]; vals: any[] }[] = [];

  await db.query(`set session_replication_role = replica`); // triggers off (bulk)

  for (const p of people) {
    const sEvento = p.evento ? stat(porEvento, p.evento) : null;
    const sFuente = stat(porFuente, p.fuente);
    if (sEvento) sEvento.total++;
    sFuente.total++;

    const ex = findExisting(p);
    const eventTag = p.evento ? `evento:${slug(p.evento)}` : null;
    const marca = p.competidor && p.competidor !== "(sin marca)" ? p.competidor : null;

    if (ex) {
      if (ex.is_accredited) {
        if (sEvento) {
          sEvento.ya_acred++;
          // pg devuelve accredited_at como Date y fecha_evento es 'YYYY-MM-DD':
          // comparar Date > string da SIEMPRE false (el string va a NaN) → normalizar a ISO
          const accISO =
            ex.accredited_at instanceof Date
              ? ex.accredited_at.toISOString().slice(0, 10)
              : (ex.accredited_at ?? null);
          if (p.fecha_evento && accISO && accISO > p.fecha_evento) sEvento.acred_post++;
        }
        sFuente.ya_acred++;
      } else {
        if (sEvento) sEvento.enriquecidos++;
        sFuente.enriquecidos++;
      }
      const sets: string[] = [];
      const vals: any[] = [];
      const add = (col: string, val: any) => {
        vals.push(val);
        sets.push(`${col} = coalesce(${col}, $${vals.length + 1})`);
      };
      if (p.phone && !ex.phone) add("phone", p.phone);
      if (p.phone && !ex.whatsapp) add("whatsapp", p.phone);
      if (p.email && !ex.email) add("email", p.email);
      if (p.ciudad && !ex.city) add("city", p.ciudad);
      if (!ex.is_accredited) {
        if (p.interesado && !ex.interest_level) add("interest_level", 3);
        if (p.casos_anio_competidor && !ex.estimated_cases_month)
          add("estimated_cases_month", Math.max(0.5, Math.round((p.casos_anio_competidor / 12) * 10) / 10));
        if (marca && !ex.uses_aligners) {
          vals.push(true);
          sets.push(`uses_aligners = $${vals.length + 1}`);
        }
        if (p.warm && ex.acquisition_stage === "identificado") {
          vals.push("contactado");
          sets.push(`acquisition_stage = $${vals.length + 1}::acq_stage`);
          vals.push("contactado");
          sets.push(
            `lifecycle_stage = case when lifecycle_stage = 'prospecto' then $${vals.length + 1}::lifecycle_stage else lifecycle_stage end`
          );
        }
      }
      const tagAdds = [eventTag, marca ? `competidor:${slug(marca)}` : null].filter(Boolean) as string[];
      if (tagAdds.length) {
        vals.push(tagAdds);
        sets.push(
          `tags = (select array(select distinct unnest(tags || $${vals.length + 1}::text[])))`
        );
      }
      if (marca) {
        vals.push([marca]);
        sets.push(
          `competitor_brands = (select array(select distinct unnest(competitor_brands || $${vals.length + 1}::text[])))`
        );
      }
      if (sets.length) updates.push({ id: ex.id, sets, vals });
      continue;
    }

    // ---------- nuevo prospecto ----------
    if (sEvento) sEvento.nuevos++;
    sFuente.nuevos++;
    const tags = ["fuente:" + p.fuente, eventTag, marca ? `competidor:${slug(marca)}` : null].filter(Boolean);
    const estCases = p.casos_anio_competidor
      ? Math.max(0.5, Math.round((p.casos_anio_competidor / 12) * 10) / 10)
      : null;
    const why =
      marca && p.casos_anio_competidor
        ? `${marca}: ~${Math.round(p.casos_anio_competidor)} casos/año`
        : marca
          ? `Usa ${marca}`
          : null;
    inserts.push([
      p.nombre,
      p.phone,
      p.phone,
      p.email,
      p.ciudad,
      p.estado,
      SOURCE_MAP[p.fuente] ?? "otro",
      p.evento ? (campId.get(p.evento) ?? null) : null,
      p.warm ? "contactado" : "prospecto",
      p.warm ? "contactado" : "identificado",
      p.interesado ? 3 : null,
      marca ? true : null,
      marca ? [marca] : [],
      estCases,
      why,
      tags,
      p.fecha_contacto ? p.fecha_contacto + "T12:00:00Z" : null,
    ]);
    const key = canonPhone(p.phone) ?? p.email ?? nameTokens(p.nombre).join(" ");
    // registrar índices para que ClearCorrect/duplicados posteriores matcheen
    const pseudo = {
      id: null as string | null,
      key,
      nombre: p.nombre,
      phone: p.phone,
      whatsapp: p.phone,
      email: p.email,
      is_accredited: false,
      acquisition_stage: p.warm ? "contactado" : "identificado",
    };
    if (canonPhone(p.phone)) byPhone.set(canonPhone(p.phone)!, pseudo);
    if (p.email) byEmail.set(p.email, pseudo);
    withTokens.push({ toks: nameTokens(p.nombre), d: pseudo });
    if (p.nota) notas.push({ doctorKey: key, nota: p.nota, fecha: p.fecha_contacto ?? p.fecha_evento });
  }

  // ---------- ejecutar updates (enriquecimiento) ----------
  for (const u of updates) {
    await db.query(
      `update doctors set ${u.sets.join(", ")} where id = $1`,
      [u.id, ...u.vals]
    );
  }
  console.log(`enriquecidos: ${updates.length}`);

  // ---------- bulk insert de nuevos ----------
  const COLS =
    "(nombre, phone, whatsapp, email, city, state, source, campaign_id, lifecycle_stage, acquisition_stage, interest_level, uses_aligners, competitor_brands, estimated_cases_month, why_interesting, tags, first_contact_at, is_demo)";
  let created = 0;
  const idByKey = new Map<string, string>();
  for (let i = 0; i < inserts.length; i += 300) {
    const chunk = inserts.slice(i, i + 300);
    const vals: any[] = [];
    const tuples = chunk.map((row) => {
      const base = vals.length;
      vals.push(...row);
      return `(${row
        .map((_, j) =>
          j === 6
            ? `$${base + j + 1}::attribution_source`
            : j === 8
              ? `$${base + j + 1}::lifecycle_stage`
              : j === 9
                ? `$${base + j + 1}::acq_stage`
                : `$${base + j + 1}`
        )
        .join(",")}, false)`;
    });
    const { rows } = await db.query(
      `insert into doctors ${COLS} values ${tuples.join(",")} returning id, nombre, phone, email`,
      vals
    );
    created += rows.length;
    for (const r of rows) {
      const k = canonPhone(r.phone) ?? r.email ?? nameTokens(r.nombre).join(" ");
      idByKey.set(k, r.id);
    }
  }
  console.log(`prospectos nuevos: ${created}`);

  // ---------- notas de outreach en el timeline ----------
  let notasIns = 0;
  for (let i = 0; i < notas.length; i += 300) {
    const chunk = notas.slice(i, i + 300).filter((n) => idByKey.has(n.doctorKey));
    if (!chunk.length) continue;
    const vals: any[] = [];
    const tuples = chunk.map((n) => {
      vals.push(idByKey.get(n.doctorKey), n.nota, n.fecha ? n.fecha + "T12:00:00Z" : new Date().toISOString());
      return `($${vals.length - 2}, 'nota', $${vals.length - 1}, $${vals.length}, false)`;
    });
    await db.query(
      `insert into activities (doctor_id, type, summary, occurred_at, is_demo) values ${tuples.join(",")}`,
      vals
    );
    notasIns += chunk.length;
  }
  console.log(`notas de gestión en timeline: ${notasIns}`);

  // ---------- ClearCorrect por email ----------
  let cc = 0;
  for (const e of ccEmails) {
    const d = byEmail.get(e);
    if (!d) continue;
    const id = d.id ?? idByKey.get(d.key);
    if (!id) continue;
    await db.query(
      `update doctors set
         competitor_brands = (select array(select distinct unnest(competitor_brands || array['ClearCorrect']))),
         uses_aligners = coalesce(uses_aligners, true),
         tags = (select array(select distinct unnest(tags || array['competidor:clearcorrect'])))
       where id = $1`,
      [id]
    );
    cc++;
  }
  console.log(`ClearCorrect etiquetados por email: ${cc} de ${ccEmails.length}`);

  await db.query(`set session_replication_role = default`); // triggers on

  // ---------- recompute total (sin timeout: conexión directa) ----------
  console.log("recompute_all()…");
  const t0 = Date.now();
  await db.query(`select recompute_all()`);
  console.log(`recompute OK en ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // ---------- reporte ----------
  console.log("\n===== POR FUENTE =====");
  for (const [k, s] of [...porFuente.entries()].sort((a, b) => b[1].total - a[1].total))
    console.log(
      `${k.padEnd(12)} total ${String(s.total).padStart(5)} · ya clientes ${String(s.ya_acred).padStart(4)} · enriquecidos ${String(s.enriquecidos).padStart(4)} · nuevos ${String(s.nuevos).padStart(5)}`
    );
  console.log("\n===== POR EVENTO (ROI) =====");
  for (const [k, s] of [...porEvento.entries()].sort((a, b) => b[1].total - a[1].total))
    console.log(
      `${k.slice(0, 32).padEnd(32)} contactos ${String(s.total).padStart(4)} · ya clientes ${String(s.ya_acred).padStart(3)} (post-evento ${s.acred_post}) · nuevos ${String(s.nuevos).padStart(4)}`
    );

  await db.query(
    `insert into sync_runs (source, started_at, finished_at, rows_upserted, status, log)
     values ('prospectos_fuentes', now(), now(), $1, 'ok', $2)`,
    [created, JSON.stringify({ enriquecidos: updates.length, notas: notasIns, clearcorrect: cc })]
  );
  await db.end();
  console.log("\n✓ universo A cargado");
}

main().catch((e) => {
  console.error("Import falló:", e);
  process.exit(1);
});

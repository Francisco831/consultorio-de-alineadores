/**
 * Importa la actividad comercial MX al CRM (tabla activities + opportunities).
 *
 *   npx tsx scripts/import-actividades-mx.ts --fuente contact-points
 *   npx tsx scripts/import-actividades-mx.ts --fuente llamadas
 *   npx tsx scripts/import-actividades-mx.ts --fuente comunicaciones
 *   npx tsx scripts/import-actividades-mx.ts --fuente oportunidades
 *
 * Fuentes:
 *   contact-points  → data/contact_points_eventos.json (intranet, eventos de Juan)
 *   llamadas        → data/llamadas_rocio.json (pestaña "Llamadas Dres" del sheet)
 *   comunicaciones  → Noloco keepsmiling-v2, motivo MODIFICACIONES_DE_VIDEO_YO_RENDERS,
 *                     ligadas a casos MX del CRM (misma fuente que el panel de Eugenia)
 *   oportunidades   → data/pipeline_agosto.json (casos en proceso que Noloco no tiene)
 *
 * Idempotente: dedup por (doctor, día, resumen) en activities y por
 * (doctor, paciente) en opportunities. Doctores sin match único se REPORTAN,
 * nunca se adivinan — mismo criterio que la adopción de fichas del sync.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";
import { fetchAll } from "./lib/fetch-all";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- matching de nombres ----------
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-zñ0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s: string): Set<string> {
  const STOP = new Set(["dr", "dra", "doctor", "doctora", "de", "del", "la", "los"]);
  return new Set(norm(s).split(" ").filter((t) => t.length > 1 && !STOP.has(t)));
}

type Doc = { id: string; nombre: string; noloco_id: string | null };

/** Desempata candidatos: match exacto del nombre completo primero; entre
 *  homónimos, la ficha conciliada con Noloco (las otras son duplicados de
 *  las fuentes de prospectos). */
function desempatar(nombreFuente: string, hits: Doc[]): Doc[] {
  if (hits.length <= 1) return hits;
  const objetivo = norm(nombreFuente.replace(",", " "));
  const exactos = hits.filter((d) => norm(d.nombre) === objetivo);
  const pool = exactos.length >= 1 ? exactos : hits;
  if (pool.length === 1) return pool;
  const conNoloco = pool.filter((d) => d.noloco_id);
  return conNoloco.length === 1 ? conNoloco : pool;
}

// Typos conocidos de la planilla → nombre como figura en el CRM
const ALIAS_FUENTE: Record<string, string> = {
  "castejon gomez ervin": "Castrejón Gómez Ervin",
  "correira figueira jose luis": "Correia Figueira Jose Luis",
  "cautetpozo luis alberto": "Cuatepotzo Olvera Luis Alberto",
  "lucia dosal gutierrez": "Dosal Guitiérrez Lucía del Carmen",
};

function matchDoctor(nombreFuente: string, doctors: Doc[]): Doc[] {
  const alias = ALIAS_FUENTE[norm(nombreFuente.replace(",", " "))];
  if (alias) nombreFuente = alias;
  const src = tokens(nombreFuente.replace(",", " "));
  if (src.size === 0) return [];
  // todos los tokens de la fuente presentes en el nombre del CRM
  const hits = doctors.filter((d) => {
    const dst = tokens(d.nombre);
    for (const t of src) if (!dst.has(t)) return false;
    return true;
  });
  if (hits.length > 0) return desempatar(nombreFuente, hits);
  // al revés: el CRM tiene menos tokens que la fuente (ej. "Bucio Sugey" vs ficha corta)
  return desempatar(
    nombreFuente,
    doctors.filter((d) => {
      const dst = tokens(d.nombre);
      if (dst.size === 0) return false;
      for (const t of dst) if (!src.has(t)) return false;
      return true;
    })
  );
}

async function cargarDoctores(): Promise<Doc[]> {
  return await fetchAll<Doc>(db, "doctors", "id, nombre, noloco_id");
}

async function perfilPorPista(pista: string): Promise<string | null> {
  const { data } = await db.from("profiles").select("id, full_name, email");
  const p = (data ?? []).find(
    (x) =>
      norm(x.full_name ?? "").includes(pista) || norm(x.email ?? "").includes(pista)
  );
  return p?.id ?? null;
}

/** Set de claves (doctor|día|summary) ya existentes, para no duplicar. */
async function actividadesExistentes(): Promise<Set<string>> {
  const rows = await fetchAll<{ doctor_id: string; occurred_at: string; summary: string | null }>(
    db,
    "activities",
    "doctor_id, occurred_at, summary"
  );
  return new Set(rows.map((r) => `${r.doctor_id}|${r.occurred_at.slice(0, 10)}|${(r.summary ?? "").slice(0, 80)}`));
}

function claveActividad(doctorId: string, iso: string, summary: string): string {
  return `${doctorId}|${iso.slice(0, 10)}|${summary.slice(0, 80)}`;
}

interface Reporte {
  insertadas: number;
  duplicadas: number;
  sinMatch: string[];
  ambiguos: string[];
}
function imprimirReporte(r: Reporte) {
  console.log(`\nInsertadas: ${r.insertadas} · ya existían: ${r.duplicadas}`);
  if (r.sinMatch.length) {
    console.log(`⚠ Sin match en doctors (${r.sinMatch.length}):`);
    for (const s of [...new Set(r.sinMatch)]) console.log(`   - ${s}`);
  }
  if (r.ambiguos.length) {
    console.log(`⚠ Ambiguos, no se importaron (${r.ambiguos.length}):`);
    for (const s of [...new Set(r.ambiguos)]) console.log(`   - ${s}`);
  }
}

// ---------- fuente: contact-points (intranet) ----------
async function importarContactPoints() {
  const eventos = JSON.parse(
    readFileSync(resolve(__dirname, "../data/contact_points_eventos.json"), "utf8")
  ) as Array<{
    dentista: string; advisor: string; activity_level: string | null;
    id: number; details: string | null; date: string; modality: string | null; reason: string | null;
  }>;
  const doctors = await cargarDoctores();
  const juan = await perfilPorPista("juan");
  const existentes = await actividadesExistentes();
  const rep: Reporte = { insertadas: 0, duplicadas: 0, sinMatch: [], ambiguos: [] };

  const filas: any[] = [];
  for (const e of eventos) {
    const hits = matchDoctor(e.dentista, doctors);
    if (hits.length === 0) { rep.sinMatch.push(e.dentista); continue; }
    if (hits.length > 1) { rep.ambiguos.push(`${e.dentista} → ${hits.map((h) => h.nombre).join(" · ")}`); continue; }
    const doctorId = hits[0].id;
    const occurred = e.date.replace(" ", "T") + "-06:00";
    const summary = e.details?.trim() || `Contacto ${e.modality ?? ""}`.trim();
    const clave = claveActividad(doctorId, occurred, summary);
    if (existentes.has(clave)) { rep.duplicadas++; continue; }
    existentes.add(clave);
    const type =
      e.reason === "KeepDay" ? "keepday"
      : /whatsapp/i.test(e.details ?? "") ? "whatsapp"
      : e.modality === "Presencial" ? "visita"
      : "reunion";
    filas.push({
      doctor_id: doctorId, type, occurred_at: occurred,
      summary, outcome: e.reason, created_by: juan,
    });
  }
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("activities").insert(filas.slice(i, i + 200));
    if (error) throw error;
  }
  rep.insertadas = filas.length;
  imprimirReporte(rep);
}

// ---------- fuente: llamadas de Rocío (sheet) ----------
async function importarLlamadas() {
  const llamadas = JSON.parse(
    readFileSync(resolve(__dirname, "../data/llamadas_rocio.json"), "utf8")
  ) as Array<{ fecha: string; doctora: string; motivo: string; reconexion: string; nota: string }>;
  const doctors = await cargarDoctores();
  const rocio = await perfilPorPista("rocio");
  const existentes = await actividadesExistentes();
  const rep: Reporte = { insertadas: 0, duplicadas: 0, sinMatch: [], ambiguos: [] };

  const filas: any[] = [];
  for (const l of llamadas) {
    const hits = matchDoctor(l.doctora, doctors);
    if (hits.length === 0) { rep.sinMatch.push(l.doctora); continue; }
    if (hits.length > 1) { rep.ambiguos.push(`${l.doctora} → ${hits.map((h) => h.nombre).join(" · ")}`); continue; }
    const doctorId = hits[0].id;
    const occurred = `${l.fecha}T12:00:00-06:00`;
    const partes = [l.motivo && `[${l.motivo}]`, l.nota, l.reconexion && `(reconexión: ${l.reconexion})`]
      .filter(Boolean);
    const summary = partes.join(" ").trim() || "Llamada";
    const clave = claveActividad(doctorId, occurred, summary);
    if (existentes.has(clave)) { rep.duplicadas++; continue; }
    existentes.add(clave);
    filas.push({
      doctor_id: doctorId, type: "llamada", occurred_at: occurred,
      summary, created_by: rocio,
    });
  }
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("activities").insert(filas.slice(i, i + 200));
    if (error) throw error;
  }
  rep.insertadas = filas.length;
  imprimirReporte(rep);
}

// ---------- fuente: comunicaciones de modificación (Noloco keepsmiling-v2) ----------
async function importarComunicaciones() {
  const email = process.env.KEEPSMILING_EMAIL;
  const password = process.env.KEEPSMILING_PASSWORD;
  if (!email || !password) {
    // las credenciales viven en tracer/.env — cargarlas si .env.local no las tiene
    config({ path: resolve(__dirname, "../../tracer/.env") });
  }
  const em = process.env.KEEPSMILING_EMAIL, pw = process.env.KEEPSMILING_PASSWORD;
  if (!em || !pw) throw new Error("Faltan KEEPSMILING_EMAIL/KEEPSMILING_PASSWORD");

  const API = "https://api.portals.noloco.io/data/keepsmiling-v2";
  async function gql(query: string, variables: Record<string, unknown>, token?: string) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-noloco-project": "keepsmiling-v2",
        "x-noloco-ghost": "false",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json();
    if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 400));
    return data.data;
  }
  const login = await gql(
    "mutation l($e:String!,$p:String!){login(email:$e,password:$p){token}}",
    { e: em, p: pw }
  );
  const token = login.login.token as string;

  // casos MX del CRM: id_externo → (case_id, doctor_id)
  const casos = await fetchAll<{ id: string; id_externo: string | null; doctor_id: string }>(
    db, "cases", "id, id_externo, doctor_id"
  );
  const porIdExterno = new Map(
    casos.filter((c) => c.id_externo).map((c) => [c.id_externo!.toUpperCase(), c])
  );

  const coms: Array<{ createdAt: string; estado: string | null; mensajeCliente: string | null; casos: { idExterno: string | null } | null }> = [];
  let after: string | null = null;
  for (;;) {
    const d: any = await gql(
      `query c($after:String) {
        keepsmilingComunicacionCollection(first: 200, after: $after,
          where: { motivo: {equals: "MODIFICACIONES_DE_VIDEO_YO_RENDERS"}, createdAt: {gte: "2026-01-01T00:00:00.000Z"} }) {
          totalCount pageInfo { hasNextPage endCursor }
          edges { node { createdAt estado mensajeCliente casos { idExterno } } }
        }
      }`,
      { after },
      token
    );
    const col = d.keepsmilingComunicacionCollection;
    coms.push(...col.edges.map((e: any) => e.node));
    if (!col.pageInfo.hasNextPage) break;
    after = col.pageInfo.endCursor;
  }
  console.log(`Comunicaciones de modificación 2026 (global): ${coms.length}`);

  const existentes = await actividadesExistentes();
  const rep: Reporte = { insertadas: 0, duplicadas: 0, sinMatch: [], ambiguos: [] };
  const filas: any[] = [];
  for (const c of coms) {
    const idext = c.casos?.idExterno?.toUpperCase();
    if (!idext) continue;
    const caso = porIdExterno.get(idext);
    if (!caso) continue; // no es un caso MX del CRM
    const msg = (c.mensajeCliente ?? "").trim();
    const summary = `Pedido de modificación (caso ${idext})${msg && msg !== "." ? `: ${msg}` : ""}`;
    const clave = claveActividad(caso.doctor_id, c.createdAt, summary);
    if (existentes.has(clave)) { rep.duplicadas++; continue; }
    existentes.add(clave);
    filas.push({
      doctor_id: caso.doctor_id, type: "revision_clinica",
      occurred_at: c.createdAt, summary, outcome: c.estado,
    });
  }
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("activities").insert(filas.slice(i, i + 200));
    if (error) throw error;
  }
  rep.insertadas = filas.length;
  imprimirReporte(rep);
}

// ---------- fuente: oportunidades (pipeline de la planilla) ----------
async function importarOportunidades() {
  const pipeline = JSON.parse(
    readFileSync(resolve(__dirname, "../data/pipeline_agosto.json"), "utf8")
  ) as Array<{
    asesor: string; pct: string; doctor: string; paciente: string;
    escaneo: string; en_noloco: boolean; opcion_pago: string; pago: string;
  }>;
  const doctors = await cargarDoctores();
  const juan = await perfilPorPista("juan");
  const rep: Reporte = { insertadas: 0, duplicadas: 0, sinMatch: [], ambiguos: [] };

  // ya-casos: si el paciente ya existe como caso del doctor, no es oportunidad
  const casos = await fetchAll<{ doctor_id: string; paciente: string | null }>(
    db, "cases", "doctor_id, paciente"
  );
  const casoKey = new Set(casos.filter((c) => c.paciente).map((c) => `${c.doctor_id}|${norm(c.paciente!)}`));
  const opps = await fetchAll<{ doctor_id: string; patient_name: string | null }>(
    db, "opportunities", "doctor_id, patient_name"
  );
  const oppKey = new Set(opps.filter((o) => o.patient_name).map((o) => `${o.doctor_id}|${norm(o.patient_name!)}`));

  const filas: any[] = [];
  for (const p of pipeline) {
    if (p.en_noloco) continue;
    const hits = matchDoctor(p.doctor, doctors);
    if (hits.length === 0) { rep.sinMatch.push(p.doctor); continue; }
    if (hits.length > 1) { rep.ambiguos.push(`${p.doctor} → ${hits.map((h) => h.nombre).join(" · ")}`); continue; }
    const doctorId = hits[0].id;
    const paciente = p.paciente.replace(/[{}]/g, "").trim();
    const key = `${doctorId}|${norm(paciente)}`;
    if (casoKey.has(key)) { rep.duplicadas++; continue; } // ya ingresó como caso
    if (oppKey.has(key)) { rep.duplicadas++; continue; }
    oppKey.add(key);
    const prob = parseInt(p.pct) || null;
    filas.push({
      doctor_id: doctorId,
      patient_name: paciente,
      stage: norm(p.escaneo) === "realizado" ? "documentacion" : "paciente_potencial",
      probability: prob,
      owner_id: p.asesor === "Juan" ? juan : null,
    });
  }
  for (const f of filas) {
    const { error } = await db.from("opportunities").insert(f);
    if (error) throw error;
  }
  rep.insertadas = filas.length;
  imprimirReporte(rep);
}

async function main() {
  const fuente = process.argv[process.argv.indexOf("--fuente") + 1];
  const fuentes: Record<string, [string, () => Promise<void>]> = {
    "contact-points": ["importar contact points del intranet a activities", importarContactPoints],
    llamadas: ["importar llamadas de Rocío (sheet) a activities", importarLlamadas],
    comunicaciones: ["importar pedidos de modificación (Noloco v2) a activities", importarComunicaciones],
    oportunidades: ["importar pipeline de la planilla a opportunities", importarOportunidades],
  };
  if (!fuente || !fuentes[fuente]) {
    console.error(`Uso: --fuente ${Object.keys(fuentes).join(" | ")}`);
    process.exit(1);
  }
  await confirmarDestino({ accion: fuentes[fuente][0], auto: process.argv.includes("--yes") });
  await fuentes[fuente][1]();
  console.log("OK ✓");
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Import falló:", e);
  process.exit(1);
});

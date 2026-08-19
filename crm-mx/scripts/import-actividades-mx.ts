/**
 * Importa la actividad comercial MX al CRM (tabla activities + opportunities).
 *
 *   npx tsx scripts/import-actividades-mx.ts --fuente contact-points
 *   npx tsx scripts/import-actividades-mx.ts --fuente llamadas
 *   npx tsx scripts/import-actividades-mx.ts --fuente comunicaciones
 *   npx tsx scripts/import-actividades-mx.ts --fuente oportunidades
 *
 * contact-points y comunicaciones usan lib/actividades-sync.ts (la MISMA
 * lógica que corre el cron /api/sync/actividades, fetch directo de la fuente).
 * llamadas y oportunidades siguen siendo solo-manuales: salen de la planilla
 * de control (sin API) parseada a data/llamadas_rocio.json y
 * data/pipeline_agosto.json.
 *
 * Idempotente todo: dedup por (doctor, día, resumen) / (doctor, paciente).
 * Doctores sin match único se REPORTAN, nunca se adivinan.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";
import { fetchAll } from "./lib/fetch-all";
import {
  norm,
  matchDoctor,
  cargarDoctores,
  perfilPorPista,
  actividadesExistentes,
  claveActividad,
  sincronizarContactPoints,
  sincronizarComunicaciones,
  type ReporteFuente,
} from "../lib/actividades-sync";

config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../../tracer/.env") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function imprimirReporte(r: ReporteFuente) {
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

async function importarContactPoints() {
  const email = process.env.INTRANET_EMAIL, pass = process.env.INTRANET_PASSWORD;
  if (!email || !pass) throw new Error("Faltan INTRANET_EMAIL/INTRANET_PASSWORD (tracer/.env)");
  imprimirReporte(await sincronizarContactPoints(db, email, pass, console.log));
}

async function importarComunicaciones() {
  const email = process.env.KEEPSMILING_EMAIL, pass = process.env.KEEPSMILING_PASSWORD;
  if (!email || !pass) throw new Error("Faltan KEEPSMILING_EMAIL/KEEPSMILING_PASSWORD (tracer/.env)");
  imprimirReporte(await sincronizarComunicaciones(db, email, pass, console.log));
}

// ---------- fuente: llamadas de Rocío (sheet, manual) ----------
async function importarLlamadas() {
  const llamadas = JSON.parse(
    readFileSync(resolve(__dirname, "../data/llamadas_rocio.json"), "utf8")
  ) as Array<{ fecha: string; doctora: string; motivo: string; reconexion: string; nota: string }>;
  const doctors = await cargarDoctores(db);
  const rocio = await perfilPorPista(db, "rocio");
  const existentes = await actividadesExistentes(db);
  const rep: ReporteFuente = { insertadas: 0, duplicadas: 0, sinMatch: [], ambiguos: [] };

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
    filas.push({ doctor_id: doctorId, type: "llamada", occurred_at: occurred, summary, created_by: rocio });
  }
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("activities").insert(filas.slice(i, i + 200));
    if (error) throw error;
  }
  rep.insertadas = filas.length;
  imprimirReporte(rep);
}

// ---------- fuente: oportunidades (pipeline de la planilla, manual) ----------
async function importarOportunidades() {
  const pipeline = JSON.parse(
    readFileSync(resolve(__dirname, "../data/pipeline_agosto.json"), "utf8")
  ) as Array<{
    asesor: string; pct: string; doctor: string; paciente: string;
    escaneo: string; en_noloco: boolean; opcion_pago: string; pago: string;
  }>;
  const doctors = await cargarDoctores(db);
  const juan = await perfilPorPista(db, "juan");
  const rep: ReporteFuente = { insertadas: 0, duplicadas: 0, sinMatch: [], ambiguos: [] };

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
    if (casoKey.has(key)) { rep.duplicadas++; continue; }
    if (oppKey.has(key)) { rep.duplicadas++; continue; }
    oppKey.add(key);
    filas.push({
      doctor_id: doctorId,
      patient_name: paciente,
      stage: norm(p.escaneo) === "realizado" ? "documentacion" : "paciente_potencial",
      probability: parseInt(p.pct) || null,
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

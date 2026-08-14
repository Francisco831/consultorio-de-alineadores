/**
 * Carga data/viabilidades.json (tab Viabilidades de la planilla de Angie/Ursula)
 * como oportunidades reales:
 *   - convertida (fecha o ID externo)        → ganada, linkeada al caso
 *   - sin convertir y ≤60 días               → abierta en etapa 'viabilidad'
 *   - sin convertir y >60 días               → perdida ("Viabilidad no convertida")
 *
 * Idempotente por external_key = viab:<fecha>:<paciente>.
 *   npx tsx scripts/import-viabilidades.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { fetchAll } from "./lib/fetch-all";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: ".env.local" });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const DOCTOR_ALIASES: Record<string, string> = { "2532": "2537" };
const OPEN_WINDOW_DAYS = 60;

interface Viab {
  asesor: string | null;
  pct_cierre: number | null;
  fecha_viab: string | null;
  doctor_raw: string | null;
  paciente: string | null;
  gestionada_por: string | null;
  id_externo: string | null;
  vencimiento: string | null;
  convertido: string | null;
  doctor_noloco_id: string | null;
}

function normKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function main() {
  await confirmarDestino({
    accion: "importar viabilidades desde la planilla (upsert)",
    auto: process.argv.includes("--yes"),
  });
  const rows: Viab[] = JSON.parse(
    readFileSync(resolve(__dirname, "../data/viabilidades.json"), "utf8")
  );

  // ambas paginadas: con 6.4k doctores y >1k casos nuevos, un select plano
  // devolvería 1.000 filas y las viabilidades caerían en el doctor equivocado
  const [doctors, cases] = await Promise.all([
    fetchAll<{ id: string; noloco_id: string | null; nombre: string }>(
      db,
      "doctors",
      "id, noloco_id, nombre"
    ),
    fetchAll<{
      id: string;
      id_externo: string | null;
      doctor_id: string;
      paciente: string | null;
      fecha_ingreso: string;
    }>(db, "cases", "id, id_externo, doctor_id, paciente, fecha_ingreso", (q) =>
      q.eq("is_new_case", true)
    ),
  ]);
  const docByNoloco = new Map((doctors ?? []).map((d) => [d.noloco_id, d.id]));
  const caseByExterno = new Map(
    (cases ?? [])
      .filter((c) => c.id_externo)
      .map((c) => [String(c.id_externo).toUpperCase(), c.id])
  );

  // detección de conversión no registrada en la planilla: viabilidad "abierta"
  // cuyo paciente ya entró como caso nuevo del mismo doctor
  const casesByDoctor = new Map<string, typeof cases>();
  for (const c of cases ?? []) {
    casesByDoctor.set(c.doctor_id, [...(casesByDoctor.get(c.doctor_id) ?? []), c]);
  }
  const toks = (s: string) =>
    new Set(
      s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2)
    );
  function findConvertedCase(doctorId: string, paciente: string, desde: string | null) {
    const pt = toks(paciente);
    if (pt.size === 0) return null;
    for (const c of casesByDoctor.get(doctorId) ?? []) {
      if (!c.paciente) continue;
      if (desde && c.fecha_ingreso < desde) continue;
      const ct = toks(c.paciente);
      let inter = 0;
      for (const t of pt) if (ct.has(t)) inter++;
      if (inter >= Math.min(2, pt.size)) return c;
    }
    return null;
  }

  const today = Date.now();
  const skipped: string[] = [];
  let ganadas = 0,
    abiertas = 0,
    perdidas = 0;

  const upserts = [];
  for (const v of rows) {
    const nolocoId = v.doctor_noloco_id
      ? (DOCTOR_ALIASES[v.doctor_noloco_id] ?? v.doctor_noloco_id)
      : null;
    let doctorId = nolocoId ? docByNoloco.get(nolocoId) : null;
    if (!doctorId && v.doctor_raw) {
      // fallback: match por nombre contra TODOS los doctores del CRM
      // (incluye prospectos que no existen en Noloco)
      const vt = toks(v.doctor_raw);
      for (const d of doctors ?? []) {
        const dt = toks(d.nombre);
        let inter = 0;
        for (const t of vt) if (dt.has(t)) inter++;
        if (inter >= Math.min(2, vt.size) && inter > 0) {
          doctorId = d.id;
          break;
        }
      }
    }
    if (!doctorId) {
      skipped.push(`${v.doctor_raw ?? "?"} / ${v.paciente ?? "?"}`);
      continue;
    }
    if (!v.paciente && !v.id_externo) continue;

    const externalKey = `viab:${v.fecha_viab ?? "sf"}:${normKey(v.paciente ?? v.id_externo ?? "")}`;
    const converted = Boolean(v.convertido || v.id_externo);
    const fecha = v.fecha_viab ? Date.parse(v.fecha_viab) : null;
    const isRecent =
      fecha != null && today - fecha <= OPEN_WINDOW_DAYS * 86_400_000;

    // ¿ya entró el caso aunque la planilla no lo marque?
    let autoCase: { id: string; fecha_ingreso: string; id_externo: string | null } | null =
      null;
    if (!converted && v.paciente) {
      autoCase = findConvertedCase(doctorId, v.paciente, v.fecha_viab);
    }

    let stage: string, closedAt: string | null, forecast: string, prob: number;
    if (autoCase) {
      stage = "ganada";
      closedAt = autoCase.fecha_ingreso;
      forecast = "closed";
      prob = 100;
      ganadas++;
    } else if (converted) {
      stage = "ganada";
      closedAt = v.convertido ?? v.fecha_viab ?? null;
      forecast = "closed";
      prob = 100;
      ganadas++;
    } else if (isRecent) {
      stage = "viabilidad";
      closedAt = null;
      forecast = "pipeline";
      prob = v.pct_cierre != null ? Math.round(v.pct_cierre * 100) : 15;
      abiertas++;
    } else {
      stage = "perdida";
      closedAt = v.vencimiento ?? v.fecha_viab ?? null;
      forecast = "omitted";
      prob = 0;
      perdidas++;
    }

    upserts.push({
      external_key: externalKey,
      doctor_id: doctorId,
      patient_name: v.paciente,
      stage,
      stage_entered_at: v.fecha_viab
        ? new Date(v.fecha_viab).toISOString()
        : new Date().toISOString(),
      probability: prob,
      forecast_category: forecast,
      closed_at: closedAt ? new Date(closedAt).toISOString() : null,
      lost_reason: stage === "perdida" ? "Viabilidad no convertida" : null,
      case_id:
        autoCase?.id ??
        (v.id_externo ? (caseByExterno.get(v.id_externo.toUpperCase()) ?? null) : null),
      is_demo: false,
    });
  }

  for (let i = 0; i < upserts.length; i += 100) {
    const { error } = await db
      .from("opportunities")
      .upsert(upserts.slice(i, i + 100), { onConflict: "external_key" });
    if (error) throw error;
  }

  console.log(
    `Viabilidades → opportunities: ${upserts.length} (ganadas ${ganadas}, abiertas ${abiertas}, perdidas ${perdidas})`
  );
  if (skipped.length) {
    console.log(`Sin doctor matcheado (quedan fuera): ${skipped.length}`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  await db.from("sync_runs").insert({
    source: "viabilidades_sheet",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    rows_upserted: upserts.length,
    status: "ok",
    log: { ganadas, abiertas, perdidas, skipped: skipped.length },
  });
  console.log("Viabilidades OK ✓");
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Import falló:", e);
  process.exit(1);
});

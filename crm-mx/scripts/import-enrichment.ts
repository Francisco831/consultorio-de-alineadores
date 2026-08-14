/**
 * Carga el enriquecimiento minado de las planillas de Drive:
 *   data/enrichment.json → teléfonos, ciudades, zonas, acreditación, competidores
 *   data/payments.json   → ledger de pagos (Administración MX)
 *
 *   npx tsx scripts/import-enrichment.ts
 *
 * Idempotente. Solo completa campos VACÍOS de doctors (nunca pisa datos cargados
 * a mano en el CRM). Pagos upsert por external_key.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { fetchAll } from "./lib/fetch-all";
import { confirmarDestino, salirConDestinoRechazado } from "./lib/destino";

config({ path: resolve(__dirname, "../.env.local") });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

interface Enrichment {
  noloco_id: string;
  nombre: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  zona: string | null;
  accredited_at: string | null;
  competitor_brands: string[];
  comercial_asignado: string | null;
}

interface PaymentRow {
  external_key: string;
  doctor_nombre_raw: string;
  noloco_id: string | null;
  case_external_id: string | null;
  paciente: string | null;
  amount_mxn: number | null;
  paid_at: string;
  method: string | null;
  notes: string | null;
}

async function main() {
  await confirmarDestino({
    accion: "cargar enriquecimiento de doctores y el ledger de pagos (upsert)",
    auto: process.argv.includes("--yes"),
  });
  const enrichPath = resolve(__dirname, "../data/enrichment.json");
  const paymentsPath = resolve(__dirname, "../data/payments.json");

  // paginado obligatorio: sin esto PostgREST devuelve 1.000 de 7.034 doctores y
  // el mapa de conciliación queda armado con una fracción arbitraria de la tabla.
  // Aguas abajo eso no "saltea": el upsert de pagos escribe doctor_id=null sobre
  // filas ya vinculadas del ledger, que es la fuente de verdad del KPI.
  const doctors = await fetchAll<{
    id: string;
    noloco_id: string | null;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    city: string | null;
    state: string | null;
    zona: string | null;
    accredited_at: string | null;
    competitor_brands: string[] | null;
    owner_id: string | null;
  }>(
    db,
    "doctors",
    "id, noloco_id, phone, whatsapp, email, city, state, zona, accredited_at, competitor_brands, owner_id"
  );
  const byNoloco = new Map(doctors.map((d) => [d.noloco_id, d]));

  // comercial_asignado → owner solo para usuarios reales del CRM.
  // Angelica/Ursula son comerciales históricas de LATAM (no usuarias): se ignoran
  // y esos doctores quedan sin owner hasta que el equipo los reparta en la app.
  const { data: profiles } = await db.from("profiles").select("id, nombre");
  const ownerByComercial = new Map<string, string>();
  for (const p of profiles ?? []) {
    const first = p.nombre.split(" ")[0].toLowerCase();
    if (["juan", "rocío", "rocio", "itzel"].includes(first)) {
      ownerByComercial.set(first, p.id);
    }
  }

  // ---------- enrichment de doctores ----------
  if (existsSync(enrichPath)) {
    const rows: Enrichment[] = JSON.parse(readFileSync(enrichPath, "utf8"));
    let updated = 0;
    for (const r of rows) {
      const d = byNoloco.get(r.noloco_id);
      if (!d) continue;
      const patch: Record<string, unknown> = {};
      if (!d.phone && r.phone) patch.phone = r.phone;
      if (!d.whatsapp && (r.whatsapp ?? r.phone)) patch.whatsapp = r.whatsapp ?? r.phone;
      if (!d.email && r.email) patch.email = r.email;
      if (!d.city && r.city) patch.city = r.city;
      if (!d.state && r.state) patch.state = r.state;
      if (!d.zona && r.zona) patch.zona = r.zona;
      if (!d.accredited_at && r.accredited_at) patch.accredited_at = r.accredited_at;
      if (
        (!d.competitor_brands || d.competitor_brands.length === 0) &&
        r.competitor_brands?.length
      ) {
        patch.competitor_brands = r.competitor_brands;
      }
      if (!d.owner_id && r.comercial_asignado) {
        const ownerId = ownerByComercial.get(
          r.comercial_asignado.trim().split(" ")[0].toLowerCase()
        );
        if (ownerId) patch.owner_id = ownerId;
      }
      if (Object.keys(patch).length > 0) {
        const { error } = await db.from("doctors").update(patch).eq("id", d.id);
        if (error) throw error;
        updated++;
      }
    }
    console.log(`Enrichment: ${updated} doctores actualizados de ${rows.length} filas`);
  } else {
    console.log("Sin data/enrichment.json — salteado (correr scripts/parse_enrichment.py)");
  }

  // ---------- pagos ----------
  if (existsSync(paymentsPath)) {
    const rows: PaymentRow[] = JSON.parse(readFileSync(paymentsPath, "utf8"));
    const vigentes = rows.filter((r) => r.paid_at && r.amount_mxn != null);

    // El upsert de PostgREST resuelve con `merge-duplicates`: hace UPDATE de todas
    // las columnas del payload, y la lista de columnas es la UNIÓN de las claves de
    // las filas enviadas. Si `doctor_id` viaja en el payload valiendo null, pisa el
    // vínculo que la fila ya tenía en la base.
    //
    // Quién puede reponerlo: solo scripts/reconcile-ledger.ts, que no está en ningún
    // runbook. Por eso las filas sin doctor se mandan SIN la columna: para una fila
    // nueva queda null igual (es el default) y para una existente se respeta lo que
    // haya, venga de donde venga.
    const comun = (r: PaymentRow) => ({
      external_key: r.external_key,
      paciente: r.paciente,
      amount_mxn: r.amount_mxn,
      paid_at: r.paid_at,
      method: r.method,
      notes: r.notes ?? (r.noloco_id ? null : `Doctor sin matchear: ${r.doctor_nombre_raw}`),
      source: "import",
    });

    const conDoctor: Array<ReturnType<typeof comun> & { doctor_id: string }> = [];
    const sinDoctor: Array<ReturnType<typeof comun>> = [];
    for (const r of vigentes) {
      const doctorId = r.noloco_id ? (byNoloco.get(r.noloco_id)?.id ?? null) : null;
      if (doctorId) conDoctor.push({ ...comun(r), doctor_id: doctorId });
      else sinDoctor.push(comun(r));
    }

    // Los dos lotes van en llamadas SEPARADAS a propósito: mezclarlos volvería a
    // meter doctor_id en la unión de columnas y el null de las filas sin doctor
    // pisaría igual.
    for (const lote of [conDoctor, sinDoctor]) {
      for (let i = 0; i < lote.length; i += 500) {
        const { error } = await db
          .from("payments")
          .upsert(lote.slice(i, i + 500), { onConflict: "external_key" });
        if (error) throw error;
      }
    }
    console.log(
      `Pagos: ${vigentes.length} upserted (${conDoctor.length} con doctor, ` +
        `${sinDoctor.length} sin matchear — su doctor_id no se toca)`
    );
  } else {
    console.log("Sin data/payments.json — salteado");
  }

  await db.from("sync_runs").insert({
    source: "sheets",
    finished_at: new Date().toISOString(),
    status: "ok",
  });

  const { error: rcErr } = await db.rpc("recompute_all");
  if (rcErr) console.warn("recompute_all:", rcErr.message);
  console.log("Enrichment OK ✓");
}

main().catch((e) => {
  salirConDestinoRechazado(e);
  console.error("Enrichment falló:", e);
  process.exit(1);
});

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
  const enrichPath = resolve(__dirname, "../data/enrichment.json");
  const paymentsPath = resolve(__dirname, "../data/payments.json");

  const { data: doctors } = await db
    .from("doctors")
    .select("id, noloco_id, phone, whatsapp, email, city, state, zona, accredited_at, competitor_brands, owner_id");
  const byNoloco = new Map((doctors ?? []).map((d) => [d.noloco_id, d]));

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
    const payRows = rows
      .filter((r) => r.paid_at && r.amount_mxn != null)
      .map((r) => ({
        external_key: r.external_key,
        doctor_id: r.noloco_id ? (byNoloco.get(r.noloco_id)?.id ?? null) : null,
        paciente: r.paciente,
        amount_mxn: r.amount_mxn,
        paid_at: r.paid_at,
        method: r.method,
        notes: r.notes ?? (r.noloco_id ? null : `Doctor sin matchear: ${r.doctor_nombre_raw}`),
        source: "import",
      }));
    for (let i = 0; i < payRows.length; i += 500) {
      const { error } = await db
        .from("payments")
        .upsert(payRows.slice(i, i + 500), { onConflict: "external_key" });
      if (error) throw error;
    }
    const matched = payRows.filter((p) => p.doctor_id).length;
    console.log(
      `Pagos: ${payRows.length} upserted (${matched} con doctor, ${payRows.length - matched} sin matchear)`
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
  console.error("Enrichment falló:", e);
  process.exit(1);
});

// Seed de la Etapa 2 (Argentina): profesionales, lista de precios KS y la
// nómina real de marzo y abril 2026.
//
// GATE: el costo laboral total de cada mes debe coincidir con el de la planilla
// ($5.931.702,26 en marzo y $6.615.822,05 en abril) o el script aborta.
//
// Uso:  npx tsx scripts/seed-etapa2.ts            (dry-run)
//       npx tsx scripts/seed-etapa2.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, argFlags } from "./lib/service-client";

// Precio de lista del Programa KeepSmiling (tratamiento 1 a 4). El consultorio
// paga lista − 40%. Fuente: consultorio-gestion/build_liquidaciones.py (LISTA_KS).
const LISTA_KS: Array<[string, string, number, number]> = [
  ["adultos", "full", 2, 2731000], ["adultos", "full", 1, 2084500],
  ["adultos", "medium", 2, 1748000], ["adultos", "medium", 1, 1315000],
  ["adultos", "fast", 2, 1353000], ["adultos", "fast", 1, 1010000],
  ["teens", "full", 2, 2550000], ["teens", "full", 1, 1945000],
  ["teens", "medium", 2, 1573000], ["teens", "medium", 1, 1183000],
  ["teens", "fast", 2, 1217000], ["teens", "fast", 1, 908000],
  ["kids", "full", 2, 2266000], ["kids", "full", 1, 1730000],
  ["kids", "medium", 2, 1398000], ["kids", "medium", 1, 1052000],
  ["kids", "fast", 2, 1081000], ["kids", "fast", 1, 808000],
];

// Las doctoras liquidan 40%; Coni cobra a cuenta propia y queda fuera.
const PROFESIONALES: Array<{ nombre: string; pct: number; aparte?: boolean }> = [
  { nombre: "Mónica González", pct: 40 },
  { nombre: "Mariana Matelli", pct: 40 },
  { nombre: "Mariana Franco", pct: 40 },
  { nombre: "Eugenia Digiano", pct: 40 },
  { nombre: "Rocío Puig", pct: 40 },
  { nombre: "Virginia", pct: 40 },
  { nombre: "Coni", pct: 40, aparte: true },
];

const COL = {
  cuil: 1, nombre: 2, ingreso: 4, basico: 5, bruto: 11,
  retenciones: 15, neto: 16, contribuciones: 21, costo: 22,
} as const;

// control declarado por la planilla (fila de totales de cada mes)
const CONTROL: Record<string, number> = { "2026-03": 5931702.26, "2026-04": 6615822.05 };

type FilaNomina = {
  cuil: string; nombre: string; ingreso: string | null;
  basico: number; bruto: number; retenciones: number; neto: number;
  contribuciones: number; costo: number;
};

function num(v: unknown): number {
  if (v == null || v === "-" || v === "") return 0;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Parte la hoja en meses: cada "SUELDOS <MES> <AÑO>" abre un bloque. */
function parsearNomina(filas: (string | null)[][]): Map<string, FilaNomina[]> {
  const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const out = new Map<string, FilaNomina[]>();
  let periodo: string | null = null;
  for (const fila of filas) {
    const primera = String(fila[0] ?? "");
    const m = primera.match(/SUELDOS\s+([A-ZÁÉÍÓÚ]+)\s+(\d{4})/i);
    if (m) {
      const idx = MESES.indexOf(m[1].toLowerCase());
      periodo = idx >= 0 ? `${m[2]}-${String(idx + 1).padStart(2, "0")}` : null;
      continue;
    }
    if (!periodo) continue;
    const cuil = String(fila[COL.cuil] ?? "").trim();
    if (!/^\d{2}-\d{7,8}-\d$/.test(cuil)) continue;   // solo filas de persona
    if (!out.has(periodo)) out.set(periodo, []);
    out.get(periodo)!.push({
      cuil,
      nombre: String(fila[COL.nombre] ?? "").replace(/\s*,\s*/, ", ").trim(),
      ingreso: (String(fila[COL.ingreso] ?? "").slice(0, 10) || null),
      basico: num(fila[COL.basico]),
      bruto: num(fila[COL.bruto]),
      retenciones: num(fila[COL.retenciones]),
      neto: num(fila[COL.neto]),
      contribuciones: num(fila[COL.contribuciones]),
      costo: num(fila[COL.costo]),
    });
  }
  return out;
}

async function main() {
  const flags = argFlags();
  const filas = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/nomina_ar_raw.json"), "utf8")
  ).filas as (string | null)[][];
  const nomina = parsearNomina(filas);

  console.log(`Nómina: ${nomina.size} período(s)`);
  let gateFalla = false;
  for (const [periodo, personas] of nomina) {
    const suma = personas.reduce((a, p) => a + p.costo, 0);
    const esperado = CONTROL[periodo];
    const ok = esperado == null || Math.abs(suma - esperado) < 1;
    if (!ok) gateFalla = true;
    console.log(
      `  ${periodo}: ${personas.length} personas · costo laboral ${suma.toLocaleString("es-AR", { maximumFractionDigits: 2 })}` +
      (esperado != null ? ` ${ok ? "✓" : `✗ (planilla dice ${esperado.toLocaleString("es-AR")})`}` : " (sin control)")
    );
  }
  if (gateFalla) {
    console.error("\n✗ GATE: el costo laboral no coincide con la planilla. No se escribe nada.");
    process.exit(1);
  }

  if (flags.dryRun) {
    console.log(`\nDRY-RUN. Además: ${LISTA_KS.length} precios KS y ${PROFESIONALES.length} profesionales.`);
    return;
  }

  const db = await serviceClient({ accion: "seed Etapa 2: profesionales, precios KS y nómina", auto: flags.yes });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");
  const companyId = cia.id;

  // ---- profesionales
  const { data: cps } = await db.from("counterparties").select("id, display_name")
    .eq("company_id", companyId).eq("kind", "professional");
  const porNombre = new Map((cps ?? []).map((c) => [c.display_name.trim().toLowerCase(), c.id]));
  for (const p of PROFESIONALES) {
    const id = porNombre.get(p.nombre.toLowerCase());
    if (!id) { console.log(`  ⚠ profesional sin contraparte: ${p.nombre}`); continue; }
    const { error } = await db.from("professionals").upsert({
      counterparty_id: id, company_id: companyId,
      settlement_pct: p.pct, settles_separately: !!p.aparte,
    }, { onConflict: "counterparty_id" });
    if (error) throw new Error(`professional ${p.nombre}: ${error.message}`);
  }
  console.log(`✓ ${PROFESIONALES.length} profesionales`);

  // ---- lista de precios KS
  for (const [audience, scope, arcades, price] of LISTA_KS) {
    const { error } = await db.from("ks_price_list").upsert({
      company_id: companyId, audience, scope, arcades,
      list_price: price, currency: "ARS", discount_pct: 40, valid_from: "2026-01-01",
    }, { onConflict: "company_id,audience,scope,arcades,valid_from" });
    if (error) throw new Error(`precio ${audience}/${scope}/${arcades}: ${error.message}`);
  }
  console.log(`✓ ${LISTA_KS.length} precios de lista KS`);

  // ---- empleadas + corridas de sueldos
  for (const [periodo, personas] of nomina) {
    for (const p of personas) {
      let { data: cp } = await db.from("counterparties").select("id")
        .eq("company_id", companyId).eq("kind", "employee").eq("display_name", p.nombre).maybeSingle();
      if (!cp) {
        const { data, error } = await db.from("counterparties")
          .insert({ company_id: companyId, kind: "employee", display_name: p.nombre, tax_id: p.cuil })
          .select("id").single();
        if (error) throw new Error(`empleada ${p.nombre}: ${error.message}`);
        cp = data;
      }
      const { error: eEmp } = await db.from("employees").upsert({
        counterparty_id: cp.id, company_id: companyId, national_id: p.cuil,
        hired_on: p.ingreso, base_salary: p.basico, currency: "ARS",
      }, { onConflict: "counterparty_id" });
      if (eEmp) throw new Error(`employee ${p.nombre}: ${eEmp.message}`);
    }

    const { data: run, error: eRun } = await db.from("payroll_runs").upsert(
      { company_id: companyId, period: periodo, status: "confirmed" },
      { onConflict: "company_id,period" }
    ).select("id").single();
    if (eRun) throw new Error(`payroll_run ${periodo}: ${eRun.message}`);

    for (const p of personas) {
      const { data: cp } = await db.from("counterparties").select("id")
        .eq("company_id", companyId).eq("kind", "employee").eq("display_name", p.nombre).single();
      const { error } = await db.from("payroll_items").upsert({
        company_id: companyId, run_id: run.id, employee_id: cp!.id, currency: "ARS",
        gross: p.bruto, deductions: p.retenciones, net: p.neto,
        employer_contributions: p.contribuciones,
        detail: { cuil: p.cuil, basico: p.basico, costo_laboral_planilla: p.costo },
      }, { onConflict: "run_id,employee_id" });
      if (error) throw new Error(`payroll_item ${periodo}/${p.nombre}: ${error.message}`);
    }
    console.log(`✓ sueldos ${periodo}: ${personas.length} empleadas`);
  }

  // ---- GATE final contra la base (total_cost es una columna calculada)
  const { data: items } = await db.from("payroll_items")
    .select("total_cost, run:payroll_runs(period)").eq("company_id", companyId);
  const enBase = new Map<string, number>();
  for (const it of items ?? []) {
    const per = (it.run as { period?: string } | null)?.period;
    if (!per) continue;
    enBase.set(per, Math.round(((enBase.get(per) ?? 0) + Number(it.total_cost)) * 100) / 100);
  }
  let falla = false;
  for (const [periodo, esperado] of Object.entries(CONTROL)) {
    const got = enBase.get(periodo) ?? 0;
    const ok = Math.abs(got - esperado) < 1;
    if (!ok) falla = true;
    console.log(`  ${ok ? "✓" : "✗ GATE"} costo laboral ${periodo}: planilla ${esperado.toLocaleString("es-AR")} · base ${got.toLocaleString("es-AR")}`);
  }
  if (falla) {
    console.error("\n✗ El costo laboral calculado por la base no coincide con la planilla.");
    process.exit(1);
  }
  console.log("\n✓ Seed Etapa 2 completo (el costo laboral de la base = el de la planilla).");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

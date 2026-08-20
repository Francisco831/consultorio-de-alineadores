// Pagos recurrentes de KS México, con los montos reales de los 7 extractos
// BBVA 2026 y los días en que efectivamente salen. Con esto el cash flow
// proyectado de MX deja de estar vacío y los vencimientos avisan antes.
//
// Días de pago observados (mediana de ene-jul):
//   sueldos y depto: primeros días del mes · alquiler oficina: ~día 3-12
//   contador: ~día 6-8 · abogados: ~día 8-10 · Clara (Actinver): ~día 8-10
//   IMSS: ~día 13-22 · SAT: ~día 13-18
//
// Uso:  npx tsx scripts/seed-recurrentes-mx.ts            (dry-run)
//       npx tsx scripts/seed-recurrentes-mx.ts --apply

import { serviceClient, argFlags } from "./lib/service-client";

const RECURRENTES = [
  { name: "Sueldo Juan Banffi", contraparte: "Juan Andrés Banffi",
    categoria: "Sueldos administración", amount: 22000, dueDay: 2 },
  { name: "Depto Juan (Weston)", contraparte: "Weston Bienes Raíces SAPI (depto Juan)",
    categoria: "Depto Juan (vivienda)", amount: 22500, dueDay: 2 },
  { name: "Sueldo Isabel (laboratorio)", contraparte: "Isabel Guadalupe Hernández Díaz",
    categoria: "Sueldos producción", amount: 12000, dueDay: 2 },
  { name: "Sueldo Jesús (laboratorio)", contraparte: "Jesús (laboratorio)",
    categoria: "Sueldos producción", amount: 9000, dueDay: 2 },
  { name: "Alquiler oficina (Eduardo Nuñez)", contraparte: "Eduardo Nuñez (arrendador)",
    categoria: "Alquiler", amount: 15517.75, dueDay: 3 },
  { name: "Contador (Gerardo Estrada)", contraparte: "Gerardo Estrada Tochimani (contador)",
    categoria: "Honorarios contables", amount: 7600, dueDay: 8 },
  { name: "Abogados (Toro Nuevos)", contraparte: "Toro Nuevos (abogados)",
    categoria: "Honorarios legales", amount: 4689.30, dueDay: 9 },
  { name: "Tarjeta Clara (domiciliación Actinver)", contraparte: "Clara (tarjeta corporativa)",
    categoria: "Tarjeta Clara", amount: 50000, dueDay: 9 },
  { name: "IMSS / INFONAVIT (SIPARE)", contraparte: "IMSS / INFONAVIT",
    categoria: "Impuestos (SAT / IMSS)", amount: 8000, dueDay: 17,
    nota: "el mes con bimestre de INFONAVIT sube a ~40.000" },
  { name: "SAT pago referenciado", contraparte: "SAT",
    categoria: "Impuestos (SAT / IMSS)", amount: 15000, dueDay: 17,
    nota: "varía con el IVA del mes: 1.500 a 27.000 en 2026" },
];

async function main() {
  const flags = argFlags();
  console.log("Reglas MX:");
  for (const r of RECURRENTES) {
    console.log(`  ${r.name.padEnd(40)} ${r.amount.toLocaleString("es-MX").padStart(10)} el día ${r.dueDay}`);
  }
  const total = RECURRENTES.reduce((a, r) => a + r.amount, 0);
  console.log(`  TOTAL fijo estimado: ${total.toLocaleString("es-MX")} MXN/mes`);
  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  const db = await serviceClient({ accion: "cargar los recurrentes de KS México", auto: flags.yes });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa 'mx' inexistente");

  const { data: cats } = await db.from("categories").select("id, name").eq("company_id", cia.id);
  const catByName = new Map((cats ?? []).map((c) => [c.name, c.id]));
  const { data: cps } = await db.from("counterparties").select("id, display_name").eq("company_id", cia.id);
  const cpByName = new Map((cps ?? []).map((c) => [c.display_name, c.id]));

  const hoy = new Date();
  for (const r of RECURRENTES) {
    const cat = catByName.get(r.categoria);
    const cp = cpByName.get(r.contraparte);
    if (!cat || !cp) throw new Error(`${r.name}: falta ${!cat ? "categoría " + r.categoria : "contraparte " + r.contraparte}`);
    // próximo vencimiento: este mes si aún no pasó, si no el que viene
    const base = hoy.getUTCDate() < r.dueDay ? hoy.getUTCMonth() : hoy.getUTCMonth() + 1;
    const next = new Date(Date.UTC(hoy.getUTCFullYear(), base, r.dueDay));
    const { error } = await db.from("recurring_rules").upsert({
      company_id: cia.id, name: r.name, counterparty_id: cp, category_id: cat,
      currency: "MXN", amount_estimated: r.amount, frequency: "monthly",
      due_day: r.dueDay, next_due_on: next.toISOString().slice(0, 10), active: true,
      notes: (r as { nota?: string }).nota ?? "monto tomado de los extractos BBVA ene-jul 2026",
    }, { onConflict: "company_id,name" });
    if (error) throw new Error(`${r.name}: ${error.message}`);
    console.log(`✓ ${r.name}`);
  }
}

main().catch((e) => { console.error(`\nERROR: ${e.message ?? e}`); process.exit(1); });

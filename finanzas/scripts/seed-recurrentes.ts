// Carga los pagos recurrentes que la conciliación dejó a la vista.
// El alquiler salió por Mercado Pago dos meses seguidos por el MISMO importe
// ($1.810.800 el 4/6 y el 8/7): es un gasto fijo que debería avisar antes de
// vencer, no aparecer recién cuando ya salió del banco.
//
// Uso: npx tsx scripts/seed-recurrentes.ts --apply

import { serviceClient, argFlags } from "./lib/service-client";

const RECURRENTES = [
  { name: "Alquiler consultorio", contraparte: "Jorge Ariel Abuliak",
    categoria: "Alquiler", amount: 1810800, frequency: "monthly", dueDay: 8 },
  { name: "Expensas Scalabrini Ortiz 3183", contraparte: "Consorcio Scalabrini Ortiz 3183",
    categoria: "Expensas / ABL", amount: 613868, frequency: "monthly", dueDay: 8 },
];

async function main() {
  const flags = argFlags();
  if (flags.dryRun) {
    console.log("DRY-RUN. Reglas a crear:");
    for (const r of RECURRENTES) console.log(`  ${r.name}: ${r.amount.toLocaleString("es-AR")} el ${r.dueDay} de cada mes`);
    return;
  }
  const db = await serviceClient({ accion: "cargar los pagos recurrentes detectados", auto: flags.yes });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");

  const { data: cats } = await db.from("categories").select("id, name").eq("company_id", cia.id);
  const catByName = new Map((cats ?? []).map((c) => [c.name, c.id]));
  const { data: cps } = await db.from("counterparties").select("id, display_name").eq("company_id", cia.id);
  const cpByName = new Map((cps ?? []).map((c) => [c.display_name, c.id]));

  // próximo vencimiento: el día pactado del mes que viene
  const hoy = new Date();
  for (const r of RECURRENTES) {
    const next = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, r.dueDay));
    const { error } = await db.from("recurring_rules").upsert({
      company_id: cia.id, name: r.name,
      counterparty_id: cpByName.get(r.contraparte) ?? null,
      category_id: catByName.get(r.categoria) ?? null,
      currency: "ARS", amount_estimated: r.amount,
      frequency: r.frequency, due_day: r.dueDay,
      next_due_on: next.toISOString().slice(0, 10), active: true,
      notes: "detectado en el extracto de Mercado Pago (jun y jul 2026)",
    }, { onConflict: "company_id,name" });
    if (error) throw new Error(`${r.name}: ${error.message}`);
    console.log(`✓ ${r.name} · ${r.amount.toLocaleString("es-AR")} el ${r.dueDay} de cada mes`);
  }
  console.log("\n✓ Reglas cargadas. El cron de recurrentes las convertirá en cuentas por pagar.");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

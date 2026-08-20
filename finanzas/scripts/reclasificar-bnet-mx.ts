// Corrige la clasificación de los pagos BBVA MX con la verdad de los
// comprobantes de Pagos/ (20/8/2026). Cada BNET quedó identificado:
//
//   1536586592  JUAN ANDRES BANFFI            sueldo gerente  → Sueldos administración
//   0194724011  WESTON BIENES RAICES SAPI     depto de Juan   → Depto Juan (vivienda)
//   1580002821  ISABEL G. HERNANDEZ DIAZ      "ISABEL LAB"    → Sueldos producción
//   1590619097  ANGELICA B. PORTUGAL BOUZA    sueldo + bonos  → Sueldos administración
//   1512798293  URSULA ANDREA PLUMA CANO      (finiquito 4/26)→ Sueldos administración
//   2915209536  GERARDO ESTRADA TOCHIMANI     "GERAR CONT"    → Honorarios contables
//   Banorte ...165398  JESUS "JESUS LAB"                      → Sueldos producción
//   ACTINVER domiciliación = pago de la tarjeta Clara (Clara opera vía
//   Actinver; enero se pagó manual por STP y desde febrero se domicilió)
//
// El laboratorio real es Jesús + Isabel (los 2 empleados que dijo Pancho).
// Mi clasificación anterior tenía a Juan y al depto como "sueldos producción"
// y a Jesús como administración: al revés. Esto lo endereza y deja el
// costo por alineador con la mano de obra correcta.
//
// Uso:  npx tsx scripts/reclasificar-bnet-mx.ts            (dry-run)
//       npx tsx scripts/reclasificar-bnet-mx.ts --apply

import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";

type Cambio = {
  patron: RegExp;                  // sobre description del movimiento
  categoria: string;
  contraparte: string;             // nombre final
  kind: "employee" | "supplier";
  renombrarDe?: string[];          // placeholders a renombrar (si existen)
  nota?: string;
};

const CAMBIOS: Cambio[] = [
  { patron: /BNET 1536586592/, categoria: "Sueldos administración",
    contraparte: "Juan Andrés Banffi", kind: "employee",
    renombrarDe: ["Empleado producción A (BNET …6592)"],
    nota: "gerente MX; comprobantes 'Sueldo Juan'" },
  { patron: /BNET 0194724011/, categoria: "Depto Juan (vivienda)",
    contraparte: "Weston Bienes Raíces SAPI (depto Juan)", kind: "supplier",
    renombrarDe: ["Empleado producción B (BNET …4011)"],
    nota: "alquiler de la vivienda de Juan; comprobantes 'Depto Juan'" },
  { patron: /BNET 1580002821/, categoria: "Sueldos producción",
    contraparte: "Isabel Guadalupe Hernández Díaz", kind: "employee",
    renombrarDe: ["Beneficiario BNET …2821 (12.000/mes)"],
    nota: "'ISABEL LAB' en el comprobante: laboratorio" },
  { patron: /BNET 1590619097/, categoria: "Sueldos administración",
    contraparte: "Angélica Beatriz Portugal Bouza", kind: "employee",
    renombrarDe: ["Beneficiario BNET …9097"],
    nota: "sueldo 11.765 + bonos; finiquito agosto 2026" },
  { patron: /BNET 1512798293/, categoria: "Sueldos administración",
    contraparte: "Úrsula Andrea Pluma Cano", kind: "employee",
    renombrarDe: ["Beneficiario BNET …8293"],
    nota: "finiquito abril 2026" },
  { patron: /BNET 2915209536/, categoria: "Honorarios contables",
    contraparte: "Gerardo Estrada Tochimani (contador)", kind: "supplier",
    renombrarDe: ["Beneficiario BNET …9536"] },
  { patron: /00072580013228165398|0\d{5}26JESUS|SUELDO ENERO 26/, categoria: "Sueldos producción",
    contraparte: "Jesús (laboratorio)", kind: "employee",
    renombrarDe: ["Jesús (administración)"],
    nota: "'JESUS LAB' en el comprobante: laboratorio, no administración" },
  { patron: /ACTINVER/, categoria: "Tarjeta Clara",
    contraparte: "Clara (tarjeta corporativa)", kind: "supplier",
    nota: "domiciliación Actinver = pago de la Clara (opera vía Actinver); enero fue manual por STP" },
];

// sueldos base para la ficha de empleados (comprobantes de enero)
const EMPLEADOS: Record<string, { sueldo: number; puesto: string; activo: boolean }> = {
  "Juan Andrés Banffi": { sueldo: 22000, puesto: "Gerente México", activo: true },
  "Isabel Guadalupe Hernández Díaz": { sueldo: 12000, puesto: "Laboratorio (producción)", activo: true },
  "Jesús (laboratorio)": { sueldo: 9000, puesto: "Laboratorio (producción)", activo: true },
  "Angélica Beatriz Portugal Bouza": { sueldo: 11765, puesto: "Administración", activo: false },
  "Úrsula Andrea Pluma Cano": { sueldo: 18000, puesto: "Administración", activo: false },
};

async function main() {
  const flags = argFlags();
  const db = await serviceClient({
    accion: "reclasificar los pagos BBVA MX con los nombres reales de los comprobantes",
    auto: flags.yes,
  });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa 'mx' inexistente");
  const companyId = cia.id;

  const { data: cats } = await db.from("categories").select("id, name").eq("company_id", companyId);
  const catByName = new Map((cats ?? []).map((c) => [c.name, c.id]));

  const movs = await fetchAllRows<{
    id: string; description: string; amount: string; occurred_on: string;
    category_id: string | null; counterparty_id: string | null;
  }>(db, "movements", "id, description, amount, occurred_on, category_id, counterparty_id",
    (q) => q.eq("company_id", companyId).eq("kind", "expense").neq("status", "void"));

  const plan = CAMBIOS.map((c) => ({
    cambio: c,
    movimientos: movs.filter((m) => c.patron.test(m.description ?? "")),
  }));
  for (const { cambio, movimientos } of plan) {
    const total = movimientos.reduce((a, m) => a + Number(m.amount), 0);
    console.log(`  ${cambio.contraparte.padEnd(44)} ${String(movimientos.length).padStart(3)} movs ` +
      `${total.toLocaleString("es-MX").padStart(12)} → ${cambio.categoria}`);
  }
  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  // categoría nueva si falta
  for (const c of CAMBIOS) {
    if (catByName.has(c.categoria)) continue;
    const { data: cat, error } = await db.from("categories")
      .insert({ company_id: companyId, name: c.categoria, flow: "expense" }).select("id").single();
    if (error) throw new Error(`categoría ${c.categoria}: ${error.message}`);
    catByName.set(c.categoria, cat.id);
    console.log(`✓ categoría creada: ${c.categoria}`);
  }

  for (const { cambio, movimientos } of plan) {
    // contraparte final: renombrar el placeholder si existe, si no get-or-create
    let cpId: string | null = null;
    for (const viejo of cambio.renombrarDe ?? []) {
      const { data: ph } = await db.from("counterparties").select("id")
        .eq("company_id", companyId).eq("display_name", viejo).maybeSingle();
      if (ph) {
        const { error } = await db.from("counterparties")
          .update({ display_name: cambio.contraparte, kind: cambio.kind }).eq("id", ph.id);
        if (error) throw new Error(`renombrar ${viejo}: ${error.message}`);
        cpId = ph.id;
        console.log(`✓ ${viejo} → ${cambio.contraparte}`);
      }
    }
    if (!cpId) {
      const { data: ex } = await db.from("counterparties").select("id")
        .eq("company_id", companyId).eq("display_name", cambio.contraparte).maybeSingle();
      if (ex) cpId = ex.id;
      else {
        const { data: c, error } = await db.from("counterparties")
          .insert({ company_id: companyId, kind: cambio.kind, display_name: cambio.contraparte })
          .select("id").single();
        if (error) throw new Error(`contraparte ${cambio.contraparte}: ${error.message}`);
        cpId = c.id;
      }
    }
    for (const m of movimientos) {
      const { error } = await db.from("movements").update({
        category_id: catByName.get(cambio.categoria),
        counterparty_id: cpId,
        meta: { origen: "extracto BBVA MX", nota: cambio.nota ?? null, reclasificado: "2026-08-20 comprobantes Pagos/" },
      }).eq("id", m.id);
      if (error) throw new Error(`mov ${m.id}: ${error.message}`);
    }
  }

  // ficha de empleados (roster; la nómina detallada vendrá cuando haga falta)
  for (const [nombre, e] of Object.entries(EMPLEADOS)) {
    const { data: cp } = await db.from("counterparties").select("id")
      .eq("company_id", companyId).eq("display_name", nombre).maybeSingle();
    if (!cp) continue;
    const { error } = await db.from("employees").upsert({
      counterparty_id: cp.id, company_id: companyId,
      position: e.puesto, base_salary: e.sueldo, currency: "MXN", active: e.activo,
    }, { onConflict: "counterparty_id" });
    if (error) throw new Error(`empleado ${nombre}: ${error.message}`);
  }
  console.log(`✓ ${Object.keys(EMPLEADOS).length} empleados en la ficha (2 de baja)`);

  const { data: v } = await db.from("v_production_cost").select("period, gasto_produccion, costo_por_alineador")
    .eq("company_id", companyId).order("period");
  console.log("\ncosto por alineador corregido:");
  for (const r of v ?? []) console.log(`  ${r.period}: ${Number(r.costo_por_alineador).toFixed(2)} (gasto ${Number(r.gasto_produccion).toLocaleString("es-MX")})`);
}

main().catch((e) => { console.error(`\nERROR: ${e.message ?? e}`); process.exit(1); });

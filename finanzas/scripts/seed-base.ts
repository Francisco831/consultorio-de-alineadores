// Seed base: las 2 empresas, cuentas, categorías, contrapartes de estructura y
// aliases de medios de pago. Idempotente: corre las veces que haga falta.
//
// Uso:  npx tsx scripts/seed-base.ts            (dry-run: muestra qué haría)
//       npx tsx scripts/seed-base.ts --apply

import { serviceClient, argFlags } from "./lib/service-client";

const OWNER_EMAIL = "francisco@keepsmiling.com.ar";

type CompanySeed = {
  slug: string; name: string; country: string; timezone: string;
  currencies: string[]; legal: Record<string, string>;
};

const COMPANIES: CompanySeed[] = [
  {
    slug: "mx",
    name: "Keep Smiling México",
    country: "MX",
    timezone: "America/Mexico_City",
    currencies: ["MXN"],
    legal: {},
  },
  {
    slug: "ar",
    name: "Consultorio Argentina",
    country: "AR",
    timezone: "America/Argentina/Buenos_Aires",
    currencies: ["ARS", "USD"],
    legal: { razon_social: "BASILICO & LAVALLE S.A.", pto_vta: "00004" },
  },
];

const ACCOUNTS: Record<string, Array<{ name: string; type: string; currency: string; bank_name?: string; include_in_totals?: boolean }>> = {
  ar: [
    { name: "Banco Macro", type: "bank", currency: "ARS", bank_name: "Macro" },
    // el extracto real trae filas BANCO="BBVA USD": cobros en dólares del consultorio
    { name: "BBVA USD", type: "bank", currency: "USD", bank_name: "BBVA" },
    { name: "Mercado Pago", type: "mercadopago", currency: "ARS" },
    { name: "Efectivo", type: "cash", currency: "ARS" },
    { name: "Efectivo USD", type: "cash", currency: "USD" },
    // La cuenta KS es caja del consultorio desde abril 2026 (regla de la caja).
    { name: "Cuenta KS", type: "external", currency: "ARS" },
    { name: "Cuenta KS USD", type: "external", currency: "USD" },
    // Coni cobra a cuenta propia: se registra, no suma a la disponibilidad.
    { name: "Coni – cuenta propia", type: "external", currency: "ARS", include_in_totals: false },
    // Cobros sembrados sin medio identificable: deuda de clasificación VISIBLE.
    { name: "Sin medio (a revisar)", type: "external", currency: "ARS", include_in_totals: false },
    { name: "Sin medio USD (a revisar)", type: "external", currency: "USD", include_in_totals: false },
  ],
  mx: [
    { name: "BBVA", type: "bank", currency: "MXN", bank_name: "BBVA" },
    { name: "Mercado Pago", type: "mercadopago", currency: "MXN" },
    { name: "Efectivo", type: "cash", currency: "MXN" },
  ],
};

type Cat = { name: string; flow: "income" | "expense"; cost_behavior?: "fixed" | "variable"; cost_center?: string; is_system?: boolean };
const CATEGORIES: Record<string, Cat[]> = {
  ar: [
    { name: "Alineadores", flow: "income" },
    { name: "Mensualidad", flow: "income" },
    { name: "Contención", flow: "income" },
    { name: "Consulta", flow: "income" },
    { name: "Otros ingresos", flow: "income" },
    { name: "Liquidaciones profesionales", flow: "expense", cost_behavior: "variable", is_system: true },
    { name: "Sueldos", flow: "expense", cost_behavior: "fixed" },
    { name: "Alquiler", flow: "expense", cost_behavior: "fixed" },
    { name: "Expensas / ABL", flow: "expense", cost_behavior: "fixed" },
    { name: "Luz", flow: "expense", cost_behavior: "fixed" },
    { name: "Gas", flow: "expense", cost_behavior: "fixed" },
    { name: "Agua", flow: "expense", cost_behavior: "fixed" },
    { name: "Internet", flow: "expense", cost_behavior: "fixed" },
    { name: "Contador", flow: "expense", cost_behavior: "fixed" },
    { name: "Impuestos", flow: "expense", cost_behavior: "fixed" },
    { name: "Seguros", flow: "expense", cost_behavior: "fixed" },
    { name: "Software", flow: "expense", cost_behavior: "fixed" },
    { name: "Insumos", flow: "expense", cost_behavior: "variable" },
    { name: "Laboratorio", flow: "expense", cost_behavior: "variable" },
    { name: "Limpieza", flow: "expense", cost_behavior: "fixed" },
    { name: "Mantenimiento", flow: "expense", cost_behavior: "variable" },
    { name: "Marketing", flow: "expense", cost_behavior: "variable" },
    { name: "Envío / Moto", flow: "expense", cost_behavior: "variable" },
    { name: "Gastos varios", flow: "expense", cost_behavior: "variable" },
    { name: "Otros gastos", flow: "expense" },
  ],
  mx: [
    { name: "Tratamientos", flow: "income", is_system: true },
    { name: "Cursos", flow: "income" },
    { name: "Placas", flow: "expense", cost_center: "produccion_mx", cost_behavior: "variable" },
    { name: "Resina", flow: "expense", cost_center: "produccion_mx", cost_behavior: "variable" },
    { name: "Packaging", flow: "expense", cost_center: "produccion_mx", cost_behavior: "variable" },
    { name: "Consumibles de producción", flow: "expense", cost_center: "produccion_mx", cost_behavior: "variable" },
    { name: "Mantenimiento de máquinas", flow: "expense", cost_center: "produccion_mx", cost_behavior: "variable" },
    { name: "Energía", flow: "expense", cost_center: "produccion_mx", cost_behavior: "fixed" },
    { name: "Sueldos producción", flow: "expense", cost_center: "produccion_mx", cost_behavior: "fixed" },
    { name: "Envíos", flow: "expense", cost_behavior: "variable" },
    { name: "Alquiler", flow: "expense", cost_behavior: "fixed" },
    { name: "Sueldos administración", flow: "expense", cost_behavior: "fixed" },
    { name: "Impuestos (SAT / IMSS)", flow: "expense", cost_behavior: "fixed" },
    { name: "Honorarios contables", flow: "expense", cost_behavior: "fixed" },
    { name: "Honorarios legales", flow: "expense", cost_behavior: "fixed" },
    { name: "Software", flow: "expense", cost_behavior: "fixed" },
    { name: "Comisiones bancarias", flow: "expense", cost_behavior: "variable" },
    { name: "Marketing", flow: "expense", cost_behavior: "variable" },
    { name: "Otros gastos", flow: "expense" },
  ],
};

const COUNTERPARTIES: Record<string, Array<{ kind: string; display_name: string }>> = {
  ar: [
    { kind: "professional", display_name: "Mónica González" },
    { kind: "professional", display_name: "Mariana Matelli" },
    { kind: "professional", display_name: "Mariana Franco" },
    { kind: "professional", display_name: "Eugenia Digiano" },
    { kind: "professional", display_name: "Rocío Puig" },
    { kind: "professional", display_name: "Coni" },
    { kind: "professional", display_name: "Virginia" },
    { kind: "tax_agency", display_name: "ARCA" },
  ],
  mx: [
    { kind: "tax_agency", display_name: "SAT" },
    { kind: "tax_agency", display_name: "IMSS" },
    { kind: "supplier", display_name: "GyG Asesores Fiscales" },
  ],
};

// Las 31 variantes reales de medio → cuenta canónica (de los 877 movimientos).
const MEDIO_ALIASES_AR: Array<{ raw: string; account: string }> = [
  ...["tr ks", "tr ks 31/10/25", "depo ks"].map((raw) => ({ raw, account: "Cuenta KS" })),
  ...["tr ks u$s", "tr ks us$"].map((raw) => ({ raw, account: "Cuenta KS USD" })),
  ...["tr mp", "mp", "tr mp basilico-lavalle", "tr mp basilico lavalle"].map((raw) => ({ raw, account: "Mercado Pago" })),
  ...["ef", "efe", "efectivo"].map((raw) => ({ raw, account: "Efectivo" })),
  ...["tr coni"].map((raw) => ({ raw, account: "Coni – cuenta propia" })),
];

async function main() {
  const flags = argFlags();
  if (flags.dryRun) {
    console.log("DRY-RUN: seed-base no escribe nada sin --apply.");
    console.log(`  ${COMPANIES.length} empresas, ${ACCOUNTS.ar.length + ACCOUNTS.mx.length} cuentas,`);
    console.log(`  ${CATEGORIES.ar.length + CATEGORIES.mx.length} categorías, aliases de medios: ${MEDIO_ALIASES_AR.length}`);
    return;
  }
  const db = await serviceClient({ accion: "seed base: empresas, cuentas, categorías, contrapartes", auto: flags.yes });

  // 1. companies
  for (const c of COMPANIES) {
    const { error } = await db.from("companies").upsert(c, { onConflict: "slug" });
    if (error) throw new Error(`companies ${c.slug}: ${error.message}`);
  }
  const { data: companies } = await db.from("companies").select("id, slug");
  const byCia = Object.fromEntries((companies ?? []).map((c) => [c.slug, c.id]));
  console.log("✓ empresas:", Object.keys(byCia).join(", "));

  // 2. membership del owner (si el usuario ya existe en auth)
  const { data: users } = await db.auth.admin.listUsers({ perPage: 200 });
  const owner = users?.users.find((u) => u.email?.toLowerCase() === OWNER_EMAIL);
  if (owner) {
    for (const slug of ["mx", "ar"]) {
      const { error } = await db.from("memberships").upsert(
        { user_id: owner.id, company_id: byCia[slug], role: "owner" },
        { onConflict: "user_id,company_id" }
      );
      if (error) throw new Error(`membership ${slug}: ${error.message}`);
    }
    console.log(`✓ membership owner (${OWNER_EMAIL}) en mx + ar`);
  } else {
    console.log(`⚠ usuario ${OWNER_EMAIL} no existe todavía en auth — crear el usuario y re-correr`);
  }

  // 3. cuentas
  for (const [slug, accounts] of Object.entries(ACCOUNTS)) {
    for (const a of accounts) {
      const { error } = await db.from("accounts").upsert(
        { company_id: byCia[slug], include_in_totals: true, ...a },
        { onConflict: "company_id,name" }
      );
      if (error) throw new Error(`account ${slug}/${a.name}: ${error.message}`);
    }
  }
  console.log("✓ cuentas");

  // 4. categorías
  for (const [slug, cats] of Object.entries(CATEGORIES)) {
    for (const c of cats) {
      const row = {
        company_id: byCia[slug],
        parent_id: null,
        name: c.name,
        flow: c.flow,
        cost_behavior: c.cost_behavior ?? null,
        cost_center: c.cost_center ?? null,
        is_system: c.is_system ?? false,
      };
      const { error } = await db.from("categories").upsert(row, {
        onConflict: "company_id,parent_id,name",
        ignoreDuplicates: false,
      });
      if (error) throw new Error(`category ${slug}/${c.name}: ${error.message}`);
    }
  }
  console.log("✓ categorías");

  // 5. contrapartes de estructura (get-or-create por nombre)
  for (const [slug, cps] of Object.entries(COUNTERPARTIES)) {
    for (const cp of cps) {
      const { data: existing } = await db
        .from("counterparties")
        .select("id")
        .eq("company_id", byCia[slug])
        .eq("display_name", cp.display_name)
        .maybeSingle();
      if (!existing) {
        const { error } = await db
          .from("counterparties")
          .insert({ company_id: byCia[slug], ...cp });
        if (error) throw new Error(`counterparty ${cp.display_name}: ${error.message}`);
      }
    }
  }
  console.log("✓ contrapartes");

  // 6. aliases de medios (AR)
  const { data: arAccounts } = await db
    .from("accounts")
    .select("id, name")
    .eq("company_id", byCia.ar);
  const accByName = Object.fromEntries((arAccounts ?? []).map((a) => [a.name, a.id]));
  for (const alias of MEDIO_ALIASES_AR) {
    const accountId = accByName[alias.account];
    if (!accountId) throw new Error(`cuenta inexistente para alias: ${alias.account}`);
    const { error } = await db.from("payment_method_aliases").upsert(
      { company_id: byCia.ar, raw_norm: alias.raw, account_id: accountId },
      { onConflict: "company_id,raw_norm" }
    );
    if (error) throw new Error(`alias ${alias.raw}: ${error.message}`);
  }
  console.log("✓ aliases de medios");
  console.log("\nSeed base completo.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

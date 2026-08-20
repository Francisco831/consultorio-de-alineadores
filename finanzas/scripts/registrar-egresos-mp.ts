// Registra los egresos que salieron por Mercado Pago y la caja nunca anotó.
//
// Los encontró la conciliación: 10 débitos de MP entre junio y julio por
// $8.954.238 que no tenían contrapartida en la planilla. Clasificación
// confirmada por Pancho el 20/8/2026:
//   · "Jorge Ariel Abuliak"                → ALQUILER del consultorio
//   · "Cons Prop R Scalabrini Ortiz 3183"  → EXPENSAS
//   · "Abad Gustavo Alberto"               → retiro de MARIANA MATELLI (se paga
//     al marido por un tema impositivo: el beneficiario económico es ella)
//   · Franco / Di Giano / Puig             → retiros de liquidación del 40%
//
// Cada egreso se crea desde su línea de extracto y queda conciliado con ella.
//
// Uso:  npx tsx scripts/registrar-egresos-mp.ts            (dry-run)
//       npx tsx scripts/registrar-egresos-mp.ts --apply

import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";

type Clasificacion = {
  /** se busca en el nombre del destinatario del extracto */
  patron: RegExp;
  categoria: string;
  /** contraparte a la que se imputa (puede diferir de quien cobró) */
  contraparte: string;
  kindContraparte: "supplier" | "professional";
  /** marca el movimiento como retiro para que entre en las liquidaciones */
  esRetiro?: boolean;
  nota?: string;
};

const REGLAS: Clasificacion[] = [
  { patron: /abuliak/i, categoria: "Alquiler", contraparte: "Jorge Ariel Abuliak", kindContraparte: "supplier" },
  { patron: /cons\s*prop|scalabrini/i, categoria: "Expensas / ABL", contraparte: "Consorcio Scalabrini Ortiz 3183", kindContraparte: "supplier" },
  { patron: /abad/i, categoria: "Liquidaciones profesionales", contraparte: "Mariana Matelli",
    kindContraparte: "professional", esRetiro: true,
    nota: "pagado a Abad Gustavo Alberto por pedido de la doctora (tema impositivo)" },
  { patron: /mariana\s*franco/i, categoria: "Liquidaciones profesionales", contraparte: "Mariana Franco", kindContraparte: "professional", esRetiro: true },
  { patron: /di\s*giano|digiano/i, categoria: "Liquidaciones profesionales", contraparte: "Eugenia Digiano", kindContraparte: "professional", esRetiro: true },
  { patron: /rocio\s*puig|rocío\s*puig/i, categoria: "Liquidaciones profesionales", contraparte: "Rocío Puig", kindContraparte: "professional", esRetiro: true },
];

async function main() {
  const flags = argFlags();
  const db = await serviceClient({
    accion: "registrar los egresos que salieron por Mercado Pago y faltaban en la caja",
    auto: flags.yes,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");
  const companyId = cia.id;

  const { data: mp } = await db.from("accounts").select("id")
    .eq("company_id", companyId).eq("name", "Mercado Pago").single();
  if (!mp) throw new Error("falta la cuenta Mercado Pago");

  const lineas = await fetchAllRows<{
    id: string; posted_on: string; amount: string; counterparty_raw: string | null;
    description_raw: string; external_key: string;
  }>(db, "statement_lines",
    "id, posted_on, amount, counterparty_raw, description_raw, external_key",
    (q) => q.eq("company_id", companyId).eq("account_id", mp.id)
            .lt("amount", 0).eq("match_status", "unidentified"));

  console.log(`${lineas.length} egresos de MP sin registrar\n`);

  const { data: cats } = await db.from("categories").select("id, name").eq("company_id", companyId);
  const catByName = new Map((cats ?? []).map((c) => [c.name, c.id]));

  const plan: Array<{ linea: typeof lineas[number]; regla: Clasificacion }> = [];
  const sinRegla: typeof lineas = [];
  for (const l of lineas) {
    const nombre = l.counterparty_raw ?? "";
    const regla = REGLAS.find((r) => r.patron.test(nombre));
    if (regla) plan.push({ linea: l, regla });
    else sinRegla.push(l);
  }

  for (const { linea, regla } of plan) {
    console.log(
      `  ${linea.posted_on}  ${(linea.counterparty_raw ?? "").padEnd(36)} ` +
      `${Math.abs(Number(linea.amount)).toLocaleString("es-AR").padStart(11)}  → ` +
      `${regla.categoria}${regla.esRetiro ? ` (retiro de ${regla.contraparte})` : ""}`
    );
  }
  for (const l of sinRegla) {
    console.log(`  ⚠ sin clasificar: ${l.posted_on} ${l.counterparty_raw} ${Math.abs(Number(l.amount)).toLocaleString("es-AR")}`);
  }

  const total = plan.reduce((a, p) => a + Math.abs(Number(p.linea.amount)), 0);
  console.log(`\nTotal a registrar: ${total.toLocaleString("es-AR")}`);

  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  // contrapartes get-or-create
  const nombres = [...new Set(plan.map((p) => p.regla.contraparte))];
  const idPorNombre = new Map<string, string>();
  for (const nombre of nombres) {
    const kind = plan.find((p) => p.regla.contraparte === nombre)!.regla.kindContraparte;
    const { data: ex } = await db.from("counterparties").select("id")
      .eq("company_id", companyId).ilike("display_name", nombre).limit(1).maybeSingle();
    if (ex) { idPorNombre.set(nombre, ex.id); continue; }
    const { data, error } = await db.from("counterparties")
      .insert({ company_id: companyId, kind, display_name: nombre }).select("id").single();
    if (error) throw new Error(`contraparte ${nombre}: ${error.message}`);
    idPorNombre.set(nombre, data.id);
  }

  let creados = 0;
  for (const { linea, regla } of plan) {
    const monto = Math.abs(Number(linea.amount));
    const { data: mov, error } = await db.from("movements").insert({
      company_id: companyId, account_id: mp.id, currency: "ARS",
      kind: "expense", status: "confirmed", occurred_on: linea.posted_on,
      amount: monto,
      category_id: catByName.get(regla.categoria) ?? null,
      counterparty_id: idPorNombre.get(regla.contraparte) ?? null,
      description: regla.esRetiro
        ? `Retiro liquidación ${regla.contraparte}`
        : `${regla.categoria} · ${linea.counterparty_raw ?? ""}`.trim(),
      source: "import",
      external_key: `mpout:${linea.external_key}`,
      meta: {
        // que las liquidaciones lo cuenten como retiro (igual que los de la caja)
        ...(regla.esRetiro ? { tipo_origen: "retiro_liquidacion", doctora: regla.contraparte } : {}),
        origen: "extracto Mercado Pago",
        beneficiario_extracto: linea.counterparty_raw,
        nota: regla.nota,
      },
    }).select("id").single();
    if (error) {
      if (error.code === "23505") { console.log(`  (ya estaba) ${linea.posted_on} ${linea.counterparty_raw}`); continue; }
      throw new Error(`movimiento ${linea.id}: ${error.message}`);
    }
    await db.from("reconciliations").insert({
      company_id: companyId, statement_line_id: linea.id, movement_id: mov.id,
      amount: linea.amount, matched_by: "rule",
    });
    await db.from("statement_lines")
      .update({ match_status: "matched", matched_movement_id: mov.id })
      .eq("id", linea.id);
    creados++;
  }

  console.log(`\n✓ ${creados} egresos registrados y conciliados con su línea de extracto.`);
  if (sinRegla.length) console.log(`  ⚠ quedan ${sinRegla.length} sin clasificar.`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

/**
 * Vuelve una liquidación confirmada a borrador, para poder recalcularla.
 *
 *   npx tsx scripts/reabrir-liquidacion.ts --doctora Virginia --periodo 2026-07 [--apply]
 *
 * Confirmar una liquidación hace dos cosas: la congela y crea la deuda en "Por
 * pagar". Reabrirla tiene que deshacer LAS DOS. Si sólo se cambiara el estado,
 * quedaría una deuda viva por un importe que ya no existe, y al reconfirmar
 * chocaría contra el unique (company_id, source, source_id) de payables — una
 * liquidación, UNA deuda.
 *
 * Por eso la deuda se BORRA en vez de anularse: anulada seguiría ocupando ese
 * unique y la liquidación no se podría volver a confirmar nunca.
 *
 * Dos frenos duros:
 *  - Una liquidación PAGADA no se reabre acá. Esa plata ya salió; deshacerla es
 *    una decisión con contrapartida contable que no puede tomar un script.
 *  - Una deuda con pagos aplicados tampoco: primero hay que desaplicar el pago.
 */
import { serviceClient, argFlags } from "./lib/service-client";

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { apply } = argFlags();
  const doctora = argValor("doctora");
  const periodo = argValor("periodo");
  if (!doctora || !periodo) {
    throw new Error('faltan --doctora "Nombre" y --periodo AAAA-MM');
  }

  const db = await serviceClient({
    accion: `reabrir la liquidación de ${doctora} de ${periodo}`,
    auto: !apply,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");

  const { data: liq, error } = await db.from("professional_settlements")
    .select("id, period, status, payable_id, totals, professional:counterparties!inner(display_name)")
    .eq("company_id", cia.id).eq("period", periodo)
    .eq("professional.display_name", doctora).maybeSingle();
  if (error) throw new Error(error.message);
  if (!liq) throw new Error(`no hay liquidación de ${doctora} en ${periodo}`);

  const totals = liq.totals as { ARS?: { due?: number; collected?: number } };
  console.log(
    `\n${doctora} · ${periodo} · estado ${liq.status}\n` +
    `  cobrado $${(totals.ARS?.collected ?? 0).toLocaleString("es-AR")} · ` +
    `a pagar $${(totals.ARS?.due ?? 0).toLocaleString("es-AR")}`
  );

  if (liq.status === "draft") {
    console.log("\nYa está en borrador: no hay nada que reabrir.");
    return;
  }
  if (liq.status !== "confirmed") {
    throw new Error(
      `está ${liq.status}: este script sólo reabre CONFIRMADAS. Una liquidación ` +
      `pagada implica plata que ya salió — eso se deshace a mano y con criterio contable.`
    );
  }

  if (liq.payable_id) {
    const { data: pay } = await db.from("payables")
      .select("id, concept, amount, status").eq("id", liq.payable_id).maybeSingle();
    const { data: pagos } = await db.from("payable_payments")
      .select("id, amount").eq("payable_id", liq.payable_id);
    console.log(
      `  deuda en Por pagar: $${Number(pay?.amount ?? 0).toLocaleString("es-AR")} ` +
      `(${pay?.status}) · pagos aplicados: ${pagos?.length ?? 0}`
    );
    if (pagos?.length) {
      throw new Error(
        `esa deuda ya tiene ${pagos.length} pago(s) aplicado(s): desaplicalos primero ` +
        `desde Por pagar, si no se borraría el respaldo de plata que salió.`
      );
    }
  }

  if (!apply) {
    console.log("\n(dry-run: pasaría a borrador y se borraría su deuda — repetir con --apply)");
    return;
  }

  // Desvincular ANTES de borrar: professional_settlements.payable_id referencia payables.
  const { error: e1 } = await db.from("professional_settlements")
    .update({ status: "draft", payable_id: null }).eq("id", liq.id);
  if (e1) throw new Error(`volver a borrador: ${e1.message}`);

  if (liq.payable_id) {
    const { error: e2 } = await db.from("payables").delete().eq("id", liq.payable_id);
    if (e2) throw new Error(`borrar la deuda: ${e2.message}`);
    console.log("✓ deuda de Por pagar borrada");
  }
  console.log(`✓ ${doctora} ${periodo} vuelve a borrador. Ahora corré:\n` +
    `    npx tsx scripts/liquidaciones.ts --apply`);
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

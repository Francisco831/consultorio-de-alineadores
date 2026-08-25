/**
 * Vuelve una liquidación confirmada a borrador, para poder recalcularla.
 *
 *   npx tsx scripts/reabrir-liquidacion.ts --doctora Virginia --periodo 2026-07 [--apply]
 *
 * La cuenta la hace reopen_settlement() en la base, la MISMA función que usa el
 * botón "Reabrir" del panel: si fueran dos implementaciones, el día que difieran
 * nadie se entera hasta que una doctora reclame. Este script queda para
 * reabrir sin abrir el navegador.
 *
 * La función anula la deuda (no la borra: "las deudas se anulan con status,
 * nunca se borran") y confirm_settlement sabe revivirla, así una liquidación se
 * puede reabrir y volver a confirmar sin chocar contra el unique de una deuda
 * por liquidación.
 *
 * Dos frenos duros, que también viven en la función:
 *  - Una liquidación PAGADA no se reabre. Esa plata ya salió; deshacerla es una
 *    decisión con contrapartida contable que no puede tomar un script.
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

  if (liq.payable_id) {
    const { data: pay } = await db.from("payables")
      .select("id, concept, amount, status").eq("id", liq.payable_id).maybeSingle();
    const { data: pagos } = await db.from("payable_payments")
      .select("id, amount").eq("payable_id", liq.payable_id);
    console.log(
      `  deuda en Por pagar: $${Number(pay?.amount ?? 0).toLocaleString("es-AR")} ` +
      `(${pay?.status}) · pagos aplicados: ${pagos?.length ?? 0}`
    );
  }

  if (!apply) {
    console.log("\n(dry-run: pasaría a borrador y su deuda quedaría anulada — repetir con --apply)");
    return;
  }

  const { error: eReopen } = await db.rpc("reopen_settlement", { p_settlement_id: liq.id });
  if (eReopen) throw new Error(eReopen.message);
  console.log(`✓ ${doctora} ${periodo} vuelve a borrador y su deuda quedó anulada. Ahora corré:\n` +
    `    npx tsx scripts/liquidaciones.ts --apply`);
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

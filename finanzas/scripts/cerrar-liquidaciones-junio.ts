// Cierra las liquidaciones de junio 2026 y anteriores: directiva de Pancho del
// 24/8/26 ("todo lo de junio dalo por cerrado"). Se marcan status=paid, con lo
// que quedan CONGELADAS (el recálculo de liquidaciones.ts no toca filas que no
// estén en draft) y en la UI figuran "Pagada" sin botón Confirmar.
//
// No crea payables ni registra pagos: los retiros reales ya están en el ledger
// (salieron por Mercado Pago) imputados a su período vía
// seed-data/periodo_liquidacion_overrides.json.
//
// Uso:  npx tsx scripts/cerrar-liquidaciones-junio.ts            (dry-run)
//       npx tsx scripts/cerrar-liquidaciones-junio.ts --apply

import { serviceClient, argFlags } from "./lib/service-client";

const HASTA = "2026-06";

async function main() {
  const flags = argFlags();
  const db = await serviceClient({
    accion: `cerrar (status=paid) las liquidaciones hasta ${HASTA} inclusive`,
    auto: flags.yes,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");

  const { data: filas } = await db.from("professional_settlements")
    .select("id, period, status, totals, professional:counterparties(display_name)")
    .eq("company_id", cia.id)
    .lte("period", HASTA)
    .eq("status", "draft")
    .order("period");

  if (!filas?.length) { console.log("Nada para cerrar: no hay borradores hasta " + HASTA + "."); return; }

  for (const f of filas) {
    const nombre = (f.professional as unknown as { display_name?: string } | null)?.display_name ?? "—";
    const due = (f.totals as { ARS?: { due?: number } })?.ARS?.due ?? 0;
    console.log(`  ${f.period}  ${nombre.padEnd(20)} liq ${Number(due).toLocaleString("es-AR")} → paid`);
  }
  console.log(`\n${filas.length} liquidaciones a cerrar.`);

  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  const { error } = await db.from("professional_settlements")
    .update({ status: "paid" })
    .eq("company_id", cia.id)
    .lte("period", HASTA)
    .eq("status", "draft");
  if (error) throw new Error(error.message);
  console.log("✓ cerradas.");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

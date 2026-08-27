// Siembra los movimientos de la caja del consultorio (seed-data/movimientos_ar_2026.json,
// que deja sync-caja-ar.ts) en el ledger.
//
// La lógica —claves, cuentas, gates— vive en lib/sync/caja-ar.ts: es la MISMA
// que corre el cron de Vercel (app/api/cron/sync). Este script es el camino de
// terminal, con dry-run y confirmación de destino; nada más.
//
// GATE DE CONTROL: después de escribir, los totales de cobros por mes y moneda
// en la BASE deben ser IDÉNTICOS a los del archivo fuente. Si difieren en un
// centavo, termina con error y lo dice fuerte.
//
// Uso:  npx tsx scripts/import-movimientos-ar.ts            (dry-run)
//       npx tsx scripts/import-movimientos-ar.ts --apply

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, argFlags } from "./lib/service-client";
import { registrarSync } from "./lib/sync-run";
import { importarCajaAr, ErrorGate } from "../lib/sync/caja-ar";
import type { MovCaja } from "../lib/import/caja-ar";

async function main() {
  const flags = argFlags();
  const filas: MovCaja[] = JSON.parse(
    readFileSync(resolve(__dirname, "../seed-data/movimientos_ar_2026.json"), "utf8")
  );

  const db = await serviceClient({
    accion: `sembrar la caja del consultorio (${filas.length} filas) en el ledger AR`,
    auto: flags.yes || flags.dryRun,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").maybeSingle();
  const corrida = flags.dryRun ? null : await registrarSync(db, "caja_ar", cia?.id);
  try {
    const r = await importarCajaAr(db, filas, { dryRun: flags.dryRun, log: (m) => console.log(m) });
    if (flags.dryRun) {
      console.log("DRY-RUN (sin --apply no escribe). Totales de la fuente:");
      for (const t of r.totales) console.log(`  ${t.clave}: ${t.fuente.toLocaleString("es-AR")}`);
      return;
    }
    for (const t of r.totales) {
      console.log(`  ✓ ${t.clave}: fuente ${t.fuente.toLocaleString("es-AR")} · base ${t.base.toLocaleString("es-AR")}`);
    }
    await corrida?.ok({ leidas: r.patas, escritas: r.escritas, log: { anuladas: r.anuladas } });
    console.log(`\n✓ GATE OK: ${r.patas} movimientos, totales idénticos a la fuente mes a mes.`);
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    await corrida?.fallo(motivo);
    console.error(e instanceof ErrorGate ? `\n✗ GATE: ${motivo}` : motivo);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

// Corrección puntual pedida por Pancho el 25/8/2026.
//
// De JULIO EN ADELANTE, los cobros que la caja le anotó a Rocío Puig, Eugenia
// Digiano y Mariana Franco no les corresponden: son pacientes que sólo pasaron
// a retirar (alineadores, contenciones), y un retiro no se le liquida a nadie —
// esa plata queda entera para la casa. La caja anota quién estaba en el
// consultorio, no quién hizo el tratamiento.
//
// No se borra nada: cada cobro queda con una imputación a NADIE
// (settlement_imputations.professional_id = NULL, migración 0022) y desde el
// panel Pancho puede devolvérselo a la doctora que corresponda con dos clics.
// Después se recalculan julio y agosto para que los totales dejen de mostrar
// una liquidación que ya no tiene cobros atrás.
//
// Uso:  npx tsx scripts/imputacion-julio-2026.ts            (muestra qué haría)
//       npx tsx scripts/imputacion-julio-2026.ts --apply

import { serviceClient, argFlags } from "./lib/service-client";
import { periodoDeMovimiento, recalcularLiquidaciones, type MovimientoBase } from "../lib/liquidaciones/recalcular";

const DOCTORAS = ["Rocío Puig", "Eugenia Digiano", "Mariana Franco"];
const DESDE = "2026-07";
const MOTIVO = "Pancho 25/8/26: la paciente sólo retiró — no se liquida a ninguna doctora";

async function main() {
  const flags = argFlags();
  const db = await serviceClient({
    accion: `sacar de la liquidación de ${DOCTORAS.join(", ")} los cobros de ${DESDE} en adelante`,
    destructivo: !flags.dryRun,   // el ensayo no pisa nada; el --apply sí
    auto: flags.dryRun,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  if (!cia) throw new Error("empresa 'ar' inexistente");

  const { data: movs } = await db.from("movements")
    .select("id, occurred_on, kind, amount, currency, meta, counterparties(display_name)")
    .eq("company_id", cia.id).eq("kind", "income").neq("status", "void")
    .gte("occurred_on", "2026-06-01").order("occurred_on").limit(1000);

  const objetivo = ((movs ?? []) as unknown as MovimientoBase[]).filter(
    (m) => DOCTORAS.includes(m.meta?.doctora ?? "") && periodoDeMovimiento(m) >= DESDE
  );

  console.log(`\nCobros que dejan de liquidarse (${objetivo.length}):`);
  for (const m of objetivo) {
    console.log(
      `  ${m.occurred_on} · ${String(m.meta?.doctora).padEnd(16)} · ` +
      `${(m.counterparties?.display_name ?? "—").padEnd(22)} · ` +
      `${Number(m.amount).toLocaleString("es-AR").padStart(10)} ${m.currency} · ${m.meta?.motivo || m.meta?.categoria_origen || "—"}`
    );
  }
  const periodos = [...new Set(objetivo.map((m) => periodoDeMovimiento(m)))].sort();
  console.log(`\nPeríodos a recalcular: ${periodos.join(" · ") || "(ninguno)"}`);

  if (flags.dryRun) { console.log("\nDRY-RUN: con --apply se aplica."); return; }
  if (!objetivo.length) return;

  const { error } = await db.from("settlement_imputations").upsert(
    objetivo.map((m) => ({
      company_id: cia.id, movement_id: m.id, professional_id: null, reason: MOTIVO,
    })),
    { onConflict: "movement_id" }
  );
  if (error) throw new Error(`imputaciones: ${error.message}`);
  console.log(`\n✓ ${objetivo.length} cobros imputados a nadie`);

  const r = await recalcularLiquidaciones(db, cia.id, { periodos });
  console.log(`✓ ${r.guardadas} liquidaciones recalculadas con ${r.items} líneas` +
    (r.congeladas.length ? ` · congeladas sin tocar: ${r.congeladas.join(", ")}` : ""));
  if (r.anuladas.length) console.log(`✓ anuladas por quedarse sin cobros: ${r.anuladas.join(" · ")}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

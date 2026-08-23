// Casos MX con su monto pactado, desde la planilla de Juan (seed-data/casos_mx.json,
// lo refresca sync-pagos-planilla del CRM). Cada fila-caso se vuelve un
// treatment_plan: el "paciente" del plan es EL DOCTOR (él es quien debe);
// el paciente real y la identidad del caso viajan en ks_price_key
// { fila, case, etapa, tipo, categoria, paciente }. Idempotente por fila.
// El progreso de cobro NO se guarda acá: sale de movements (external_key
// adminmx:{fila}:{slot}) — una sola fuente de verdad.
//
// Uso:  npx tsx scripts/import-casos-mx.ts            (dry-run)
//       npx tsx scripts/import-casos-mx.ts --apply
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";

type Caso = {
  fila: number; case_id: string; tipo: string | null; etapa: string | null;
  paciente: string | null; profesional: string | null; fecha: string | null;
  categoria: string | null; importe_lista: number | null; valor: number;
  pagado: number;
};

async function main() {
  const flags = argFlags();
  const casos: Caso[] = JSON.parse(readFileSync(resolve(__dirname, "../seed-data/casos_mx.json"), "utf8"));

  const db = await serviceClient({ accion: `sembrar ${casos.length} casos MX (planilla)`, auto: flags.yes });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa mx inexistente");
  const companyId = cia.id;

  // doctores: get-or-create por nombre (mismo criterio que import-payments-mx)
  const docs = await fetchAllRows<{ id: string; display_name: string }>(
    db, "counterparties", "id, display_name",
    (q) => q.eq("company_id", companyId).eq("kind", "doctor_customer"));
  const docPorNombre = new Map(docs.map((d) => [d.display_name.trim().toLowerCase(), d.id]));
  const faltantes = new Map<string, string>();
  for (const c of casos) {
    const n = (c.profesional ?? "").trim();
    if (n && !docPorNombre.has(n.toLowerCase())) faltantes.set(n.toLowerCase(), n);
  }

  const existentes = await fetchAllRows<{ id: string; ks_price_key: { fila?: number; pagado?: number } | null; total_amount: string | null }>(
    db, "treatment_plans", "id, ks_price_key, total_amount",
    (q) => q.eq("company_id", companyId));
  const porFila = new Map(existentes.filter((e) => e.ks_price_key?.fila).map((e) => [e.ks_price_key!.fila!, e]));

  const nuevos = casos.filter((c) => !porFila.has(c.fila));
  const cambiados = casos.filter((c) => {
    const e = porFila.get(c.fila);
    return e && (
      Math.abs(Number(e.total_amount ?? 0) - c.valor) > 0.01 ||
      Math.abs((e.ks_price_key?.pagado ?? 0) - c.pagado) > 0.01
    );
  });
  console.log(`${casos.length} casos en la planilla · ${existentes.length} en la base · ` +
    `${nuevos.length} nuevos · ${cambiados.length} con precio cambiado · ${faltantes.size} doctores a crear`);

  // CONTROL planilla vs ledger (el gemelo MX del control anti-Etchegoyen de la
  // caja AR): el "pagado" de la barra sale de la planilla y el detalle de pagos
  // del ledger (adminmx:{fila}:{slot}) — si divergen, alguien ve plata que no
  // está o al revés. El ledger solo tiene pagos 2026, así que en casos viejos
  // planilla > ledger es normal; lo anormal es (a) ledger > planilla en
  // cualquier caso, (b) cualquier diferencia en casos iniciados en 2026.
  {
    const pagosLedger = await fetchAllRows<{ amount: string; external_key: string | null }>(
      db, "movements", "amount, external_key",
      (q) => q.eq("company_id", companyId).eq("kind", "income")
        .like("external_key", "adminmx:%").neq("status", "void"));
    const sumaFila = new Map<number, number>();
    for (const pg of pagosLedger) {
      const f = Number((pg.external_key ?? "").match(/^adminmx:(\d+):/)?.[1]);
      if (f) sumaFila.set(f, (sumaFila.get(f) ?? 0) + Number(pg.amount));
    }
    const filasPlanilla = new Set(casos.map((c) => c.fila));
    const huerfanos = [...sumaFila.keys()].filter((f) => !filasPlanilla.has(f));
    const sospechosos = casos.filter((c) => {
      const sum = sumaFila.get(c.fila) ?? 0;
      return sum - c.pagado > 1 || ((c.fecha ?? "") >= "2026-01-01" && Math.abs(sum - c.pagado) > 1);
    });
    if (huerfanos.length) {
      console.log(`\n⚠ ${huerfanos.length} fila(s) con pagos en el ledger que NO existen en la planilla: ${huerfanos.slice(0, 10).join(", ")}${huerfanos.length > 10 ? "…" : ""}`);
    }
    if (sospechosos.length) {
      console.log(`\n⚠ ${sospechosos.length} caso(s) donde planilla y ledger dicen distinto:`);
      for (const c of sospechosos.slice(0, 15)) {
        console.log(`  · fila ${c.fila} ${c.paciente ?? "—"} (${c.fecha ?? "sin fecha"}): planilla ${c.pagado.toLocaleString("es-MX")} vs ledger ${(sumaFila.get(c.fila) ?? 0).toLocaleString("es-MX")}`);
      }
      if (sospechosos.length > 15) console.log(`  … y ${sospechosos.length - 15} más`);
      console.log("  → revisar el sync planilla→CRM→finanzas antes de confiar en la barra de esos casos.");
    }
  }

  if (flags.dryRun) { console.log("DRY-RUN (sin --apply no escribe)."); return; }

  if (faltantes.size) {
    const { error } = await db.from("counterparties").insert(
      [...faltantes.values()].map((name) => ({ company_id: companyId, kind: "doctor_customer", display_name: name })));
    if (error) throw new Error(`alta doctores: ${error.message}`);
    const refresco = await fetchAllRows<{ id: string; display_name: string }>(
      db, "counterparties", "id, display_name",
      (q) => q.eq("company_id", companyId).eq("kind", "doctor_customer"));
    docPorNombre.clear();
    for (const d of refresco) docPorNombre.set(d.display_name.trim().toLowerCase(), d.id);
  }

  const filas = nuevos
    .filter((c) => c.profesional && docPorNombre.get(c.profesional.trim().toLowerCase()))
    .map((c) => ({
      company_id: companyId,
      patient_id: docPorNombre.get(c.profesional!.trim().toLowerCase())!,
      kind: "alineadores",
      currency: "MXN",
      total_amount: c.valor,
      started_on: c.fecha,
      is_additional_stage: !/^(etapa\s*1|s1|1)$/i.test(c.etapa ?? ""),
      notes: [c.paciente, c.tipo, c.etapa].filter(Boolean).join(" · ") || null,
      ks_price_key: {
        fila: c.fila, case: c.case_id, etapa: c.etapa, tipo: c.tipo,
        categoria: c.categoria, paciente: c.paciente, importe_lista: c.importe_lista,
        pagado: c.pagado,
      },
    }));
  const sinDoctor = nuevos.length - filas.length;
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await db.from("treatment_plans").insert(filas.slice(i, i + 500));
    if (error) throw new Error(`alta casos: ${error.message}`);
  }
  for (const c of cambiados) {
    const e = porFila.get(c.fila)!;
    const { error } = await db.from("treatment_plans")
      .update({ total_amount: c.valor, ks_price_key: { ...e.ks_price_key, pagado: c.pagado } })
      .eq("id", e.id);
    if (error) throw new Error(`precio fila ${c.fila}: ${error.message}`);
  }
  console.log(`✓ ${filas.length} casos creados (${sinDoctor} sin doctor, salteados) · ${cambiados.length} precios actualizados`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

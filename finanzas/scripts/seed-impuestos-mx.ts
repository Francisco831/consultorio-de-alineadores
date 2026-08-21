// Calendario fiscal de KS México, armado desde los pagos REALES del extracto.
//
// El sistema NO liquida impuestos — eso lo hace el contador (Gerardo). Acá:
//   · pasado: cada pago SAT/SIPARE del extracto se vuelve una obligación
//     'paid' con su monto final. El período del IMSS viene EN la referencia
//     (SIPARE ... 202604 = abril 2026); el del SAT se asume el mes anterior
//     al pago (así pagan las provisionales: día ~17 del mes siguiente).
//     OJO: el supuesto falla con pagos TARDÍOS — los comprobantes de Pagos/
//     mostraron que marzo se pagó el 22/5 y abril recién el 6/8. Esas dos
//     correcciones se aplicaron a mano el 20/8 (ver git); si este seed se
//     recorre desde cero hay que reponerlas. Ídem las del 21/8: SIPARE julio
//     pagado 14/8 ($5.484,29, período 202607), SAT julio pagado 19/8 ($3.913,
//     con nota de posible segundo pago faltante) y estimados SIPARE impares
//     (sep/nov) bajados a 5.484,29 tras la salida de Angélica — los tres
//     recién van a aparecer en el extracto de agosto.
//   · futuro: obligaciones 'estimated' hasta fin de año con la mediana
//     histórica. IMSS alterna: los períodos pares cierran bimestre de
//     INFONAVIT y saltan de ~8k a ~40k. El monto final lo pone el contador.
//
// Uso:  npx tsx scripts/seed-impuestos-mx.ts            (dry-run)
//       npx tsx scripts/seed-impuestos-mx.ts --apply

import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";

const mediana = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const dia17Siguiente = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 17));   // mes siguiente, día 17
  return d.toISOString().slice(0, 10);
};

async function main() {
  const flags = argFlags();
  const db = await serviceClient({
    accion: "armar el calendario fiscal MX desde los pagos reales",
    auto: flags.yes,
  });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "mx").single();
  if (!cia) throw new Error("empresa 'mx' inexistente");
  const companyId = cia.id;

  const { data: cat } = await db.from("categories").select("id")
    .eq("company_id", companyId).eq("name", "Impuestos (SAT / IMSS)").single();
  const pagos = await fetchAllRows<{ occurred_on: string; amount: string; description: string }>(
    db, "movements", "occurred_on, amount, description",
    (q) => q.eq("company_id", companyId).eq("category_id", cat!.id)
            .eq("kind", "expense").neq("status", "void"));

  // ---- pasado: pagos reales → obligaciones pagadas ----
  type Ob = { period: string; amount: number; notas: string[] };
  const sat = new Map<string, Ob>(), imss = new Map<string, Ob>();
  for (const p of pagos) {
    const monto = Number(p.amount);
    const ref = p.description.match(/SIPARE\s+\S+\s+(20\d{4})/);
    if (ref) {
      const period = `${ref[1].slice(0, 4)}-${ref[1].slice(4)}`;
      const o = imss.get(period) ?? { period, amount: 0, notas: [] };
      o.amount += monto;
      o.notas.push(`pagado ${p.occurred_on}`);
      imss.set(period, o);
    } else if (/\bSAT\b/.test(p.description)) {
      // período = mes anterior a la fecha de pago
      const d = new Date(p.occurred_on + "T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() - 1);
      const period = d.toISOString().slice(0, 7);
      const o = sat.get(period) ?? { period, amount: 0, notas: [] };
      o.amount += monto;
      o.notas.push(`pagado ${p.occurred_on}`);
      sat.set(period, o);
    }
  }

  // ---- futuro: estimaciones desde la historia ----
  const estSat = mediana([...sat.values()].map((o) => o.amount));
  const chicos = [...imss.values()].map((o) => o.amount).filter((a) => a < 20000);
  const grandes = [...imss.values()].map((o) => o.amount).filter((a) => a >= 20000);
  const estImssChico = mediana(chicos), estImssGrande = mediana(grandes);

  const futuros: string[] = [];
  for (let m = 7; m <= 11; m++) futuros.push(`2026-${String(m).padStart(2, "0")}`);

  console.log(`SAT: ${sat.size} períodos pagados · estimación futura ${estSat.toLocaleString("es-MX")}/mes`);
  console.log(`IMSS/INFONAVIT: ${imss.size} períodos pagados · estimación ${estImssChico.toLocaleString("es-MX")} (mes impar) / ${estImssGrande.toLocaleString("es-MX")} (par, cierra bimestre INFONAVIT)`);
  console.log(`futuros a crear: ${futuros.join(", ")} (vencen el 17 del mes siguiente)`);
  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe)."); return; }

  // ---- taxes ----
  async function tax(name: string, jurisdiction: string, frequency: string, notes: string) {
    const { data: ex } = await db.from("taxes").select("id")
      .eq("company_id", companyId).eq("name", name).eq("jurisdiction", jurisdiction).maybeSingle();
    if (ex) return ex.id;
    const { data, error } = await db.from("taxes")
      .insert({ company_id: companyId, name, jurisdiction, frequency, notes }).select("id").single();
    if (error) throw new Error(`tax ${name}: ${error.message}`);
    return data.id;
  }
  const satId = await tax("Pago referenciado (ISR/IVA)", "SAT", "monthly",
    "Dos referencias por mes: una fija ~1.6k y una variable. La liquida el contador; acá se registra y se proyecta.");
  const imssId = await tax("SIPARE (IMSS + INFONAVIT)", "IMSS", "monthly",
    "Los períodos pares cierran bimestre de INFONAVIT y saltan de ~8k a ~40k.");

  async function upsertOb(taxId: string, period: string, monto: number, status: string, notes: string) {
    const { error } = await db.from("tax_obligations").upsert({
      company_id: companyId, tax_id: taxId, period,
      due_on: dia17Siguiente(period),
      amount_estimated: status === "estimated" ? monto : null,
      amount_final: status === "paid" ? monto : null,
      status, notes,
    }, { onConflict: "company_id,tax_id,period" });
    if (error) throw new Error(`obligación ${period}: ${error.message}`);
  }

  for (const o of sat.values()) await upsertOb(satId, o.period, o.amount, "paid", o.notas.join(" · "));
  for (const o of imss.values()) await upsertOb(imssId, o.period, o.amount, "paid", o.notas.join(" · "));
  for (const period of futuros) {
    if (!sat.has(period)) await upsertOb(satId, period, estSat, "estimated", "mediana 2026; el monto final lo da el contador");
    const par = Number(period.slice(5)) % 2 === 0;
    if (!imss.has(period)) await upsertOb(imssId, period, par ? estImssGrande : estImssChico, "estimated",
      par ? "cierra bimestre INFONAVIT (estimado alto)" : "mes sin bimestre (estimado bajo)");
  }
  const { data: obs } = await db.from("tax_obligations").select("period, due_on, status, amount_estimated, amount_final")
    .eq("company_id", companyId).order("due_on");
  console.log(`\n${obs?.length} obligaciones en el calendario:`);
  for (const o of obs ?? []) {
    console.log(`  ${o.period} vence ${o.due_on} [${o.status}] ${Number(o.amount_final ?? o.amount_estimated).toLocaleString("es-MX")}`);
  }
}

main().catch((e) => { console.error(`\nERROR: ${e.message ?? e}`); process.exit(1); });

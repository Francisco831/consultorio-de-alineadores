// Corre el matcher sobre las líneas de extracto ya sembradas y deja la cola de
// conciliación poblada (sugerencias + estados), para que la app abra con trabajo
// real listo para revisar. Es el smoke test del motor contra datos de verdad.
//
// Uso:  npx tsx scripts/conciliar-inicial.ts            (dry-run: solo reporta)
//       npx tsx scripts/conciliar-inicial.ts --apply

import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";
import { matchear, type LineaExtracto, type MovimientoCandidato } from "../lib/conciliacion/matcher";

async function main() {
  const flags = argFlags();
  // --empresa=mx corre el matcher sobre México; el default sigue siendo AR
  const slug = process.argv.find((a) => a.startsWith("--empresa="))?.split("=")[1] ?? "ar";
  const db = await serviceClient({
    accion: `correr el matcher y poblar la cola de conciliación (${slug})`,
    auto: flags.yes,
  });

  const { data: cia } = await db.from("companies").select("id").eq("slug", slug).single();
  if (!cia) throw new Error(`empresa '${slug}' inexistente`);
  const companyId = cia.id;

  const lineas = await fetchAllRows<{
    id: string; posted_on: string; amount: string; currency: string;
    counterparty_raw: string | null; description_raw: string; external_key: string;
  }>(db, "statement_lines", "id, posted_on, amount, currency, counterparty_raw, description_raw, external_key",
    (q) => q.eq("company_id", companyId).in("match_status", ["pending", "unidentified"]));

  const movs = await fetchAllRows<{
    id: string; occurred_on: string; amount: string; currency: string; kind: string;
    description: string | null; external_key: string | null;
    counterparties: { display_name: string } | null;
  }>(db, "movements",
    "id, occurred_on, amount, currency, kind, description, external_key, counterparties(display_name)",
    (q) => q.eq("company_id", companyId).neq("status", "void").in("kind", ["income", "expense"]));

  console.log(`${lineas.length} líneas por conciliar · ${movs.length} movimientos candidatos\n`);

  const sugerencias: Array<{ lineaId: string; movementIds: string[]; score: number; method: string }> = [];
  const sinMatch: string[] = [];

  for (const currency of new Set(lineas.map((l) => l.currency))) {
    for (const signo of [1, -1] as const) {
      const kind = signo > 0 ? "income" : "expense";
      const ls: LineaExtracto[] = lineas
        .filter((l) => l.currency === currency && Math.sign(Number(l.amount)) === signo)
        .map((l) => ({
          id: l.id, fecha: l.posted_on, monto: Math.abs(Number(l.amount)),
          nombre: l.counterparty_raw || l.description_raw || "", externalKey: l.external_key,
        }));
      if (!ls.length) continue;
      const ms: MovimientoCandidato[] = movs
        .filter((m) => m.currency === currency && m.kind === kind)
        .map((m) => ({
          id: m.id, fecha: m.occurred_on, monto: Number(m.amount),
          nombre: m.counterparties?.display_name || m.description || "",
          externalKey: m.external_key,
        }));
      const r = matchear(ls, ms);
      sugerencias.push(...r.sugerencias);
      sinMatch.push(...r.lineasSinMatch);
      console.log(`  ${currency} ${kind}: ${ls.length} líneas vs ${ms.length} movimientos → ${r.sugerencias.length} con candidato, ${r.lineasSinMatch.length} sin`);
    }
  }

  const porMetodo = sugerencias.reduce<Record<string, number>>((a, s) => {
    a[s.method] = (a[s.method] ?? 0) + 1;
    return a;
  }, {});
  console.log(`\nTotal: ${sugerencias.length} sugerencias · ${sinMatch.length} sin candidato`);
  console.log("Por método:", porMetodo);
  const altas = sugerencias.filter((s) => s.score >= 0.8).length;
  console.log(`Confianza ≥80%: ${altas} (confirmables en bloque)`);

  if (flags.dryRun) {
    console.log("\nDRY-RUN (sin --apply no escribe).");
    return;
  }

  for (const s of sugerencias) {
    await db.from("match_suggestions").delete().eq("statement_line_id", s.lineaId);
    const { error } = await db.from("match_suggestions").insert(
      s.movementIds.map((mid) => ({
        company_id: companyId, statement_line_id: s.lineaId, movement_id: mid,
        score: s.score, method: s.method,
      }))
    );
    if (error) throw new Error(`sugerencia ${s.lineaId}: ${error.message}`);
    await db.from("statement_lines")
      .update({ match_status: "suggested", match_score: s.score, match_method: s.method })
      .eq("id", s.lineaId);
  }
  for (let i = 0; i < sinMatch.length; i += 200) {
    const { error } = await db.from("statement_lines")
      .update({ match_status: "unidentified" })
      .in("id", sinMatch.slice(i, i + 200));
    if (error) throw new Error(`sin match: ${error.message}`);
  }
  console.log("\n✓ Cola de conciliación poblada.");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

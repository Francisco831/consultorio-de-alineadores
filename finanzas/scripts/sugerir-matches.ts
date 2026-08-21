// Genera sugerencias de conciliación (mismo motor que el botón "Sugerir" de la
// UI) para que la cola amanezca lista después del sync diario. Solo SUGIERE
// (statement_lines → suggested); confirmar sigue siendo humano.
//
// Uso:  npx tsx scripts/sugerir-matches.ts --empresa mx --apply
import { matchear, type LineaExtracto, type MovimientoCandidato } from "../lib/conciliacion/matcher";
import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const flags = argFlags();
  const empresa = argValor("empresa") ?? "mx";
  const db = await serviceClient({ accion: `sugerir matches de conciliación (${empresa})`, auto: flags.yes });
  const { data: cia } = await db.from("companies").select("id").eq("slug", empresa).single();
  if (!cia) throw new Error(`empresa '${empresa}' inexistente`);
  const companyId = cia.id;

  const lineas = await fetchAllRows<{
    id: string; posted_on: string; amount: number; currency: string;
    counterparty_raw: string | null; description_raw: string; external_key: string;
  }>(db, "statement_lines", "id, posted_on, amount, currency, counterparty_raw, description_raw, external_key",
    (q) => q.eq("company_id", companyId).in("match_status", ["pending", "unidentified"]));
  if (!lineas.length) { console.log("0 líneas pendientes — nada que sugerir."); return; }

  const recon = await fetchAllRows<{ movement_id: string }>(
    db, "reconciliations", "movement_id", (q) => q.eq("company_id", companyId));
  const yaConciliados = new Set(recon.map((r) => r.movement_id));

  const movs = await fetchAllRows<{
    id: string; occurred_on: string; amount: number; currency: string; kind: string;
    description: string | null; external_key: string | null;
    counterparty: { display_name?: string } | { display_name?: string }[] | null;
  }>(db, "movements", "id, occurred_on, amount, currency, kind, description, external_key, counterparty:counterparties(display_name)",
    (q) => q.eq("company_id", companyId).neq("status", "void").in("kind", ["income", "expense"]));

  let sugeridas = 0, sinMatch = 0;
  for (const currency of new Set(lineas.map((l) => l.currency))) {
    for (const signo of [1, -1]) {
      const kind = signo > 0 ? "income" : "expense";
      const ls: LineaExtracto[] = lineas
        .filter((l) => l.currency === currency && Math.sign(Number(l.amount)) === signo)
        .map((l) => ({
          id: l.id, fecha: l.posted_on, monto: Math.abs(Number(l.amount)),
          nombre: l.counterparty_raw || l.description_raw || "", externalKey: l.external_key,
        }));
      if (!ls.length) continue;
      const ms: MovimientoCandidato[] = movs
        .filter((m) => m.currency === currency && m.kind === kind && !yaConciliados.has(m.id))
        .map((m) => ({
          id: m.id, fecha: m.occurred_on, monto: Number(m.amount),
          nombre: (Array.isArray(m.counterparty) ? m.counterparty[0]?.display_name : m.counterparty?.display_name)
            || m.description || "",
          externalKey: m.external_key,
        }));

      const r = matchear(ls, ms);
      sinMatch += r.lineasSinMatch.length;
      if (flags.dryRun) { sugeridas += r.sugerencias.length; continue; }
      for (const s of r.sugerencias) {
        await db.from("match_suggestions").delete().eq("statement_line_id", s.lineaId);
        const { error } = await db.from("match_suggestions").insert(
          s.movementIds.map((mid) => ({
            company_id: companyId, statement_line_id: s.lineaId,
            movement_id: mid, score: s.score, method: s.method,
          })));
        if (!error) {
          await db.from("statement_lines")
            .update({ match_status: "suggested", match_score: s.score, match_method: s.method })
            .eq("id", s.lineaId);
          sugeridas++;
        }
      }
    }
  }
  console.log(`${flags.dryRun ? "DRY-RUN · " : ""}${sugeridas} sugerencias · ${sinMatch} líneas sin candidato` +
    ` · confirmar en /${empresa}/movimientos/conciliar`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

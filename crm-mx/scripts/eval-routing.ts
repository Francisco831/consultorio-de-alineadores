/**
 * Evaluación del ruteo de agentes — SIN tokens, SIN modelo, SIN red.
 *
 * Corre los 20 escenarios sintéticos y los chequeos de regresión del harness
 * (lib/ai/eval/) contra el router determinístico y el renderer de contexto.
 * Un fallo acá es un hallazgo sobre las reglas de ruteo, no necesariamente un
 * bug del harness.
 *
 *   npx tsx scripts/eval-routing.ts
 *
 * Sale con código 1 si falla algún escenario o algún chequeo de regresión
 * ejecutable. Los chequeos marcados PENDIENTE (dependen de módulos que todavía
 * no existen) se informan aparte y NO afectan el código de salida.
 */
import {
  isPending,
  observedRoutingShape,
  runRegressionChecks,
  runRoutingEval,
  type EvalResult,
  type RegressionCheck,
} from "@/lib/ai/eval/harness";
import { SCENARIOS } from "@/lib/ai/eval/scenarios";

const SHAPE_LABEL: Record<string, string> = {
  contrato_nuevo: "contrato nuevo (primary + supporting + routing_reason)",
  legacy_involvements: "legacy (primary + involvements) — módulo C todavía no migró RoutingResult",
  desconocida: "desconocida — routeDoctor no devolvió ni supporting ni involvements",
};

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function lista(xs: string[]): string {
  return xs.length === 0 ? "—" : xs.join("+");
}

function titulo(t: string): void {
  console.log("");
  console.log(t);
  console.log("=".repeat(Math.max(t.length, 60)));
}

function tablaEscenarios(results: EvalResult[]): void {
  const W_ID = 38;
  const W_AG = 24;
  console.log(
    `${pad("ESCENARIO", W_ID)} ${pad("ESTADO", 7)} ${pad("PRIMARIO esp → real", W_AG * 2 + 3)} APOYO esp → real`
  );
  console.log("-".repeat(120));
  for (const r of results) {
    const estado = r.passed ? "OK" : "FALLA";
    const prim = `${pad(r.expected_primary ?? "ninguno", W_AG)} → ${pad(r.actual_primary ?? "ninguno", W_AG)}`;
    const sup = `${lista(r.expected_supporting)} → ${lista(r.actual_supporting)}`;
    console.log(`${pad(r.id, W_ID)} ${pad(estado, 7)} ${prim}  ${sup}`);
  }
}

function detalleFallos(results: EvalResult[]): void {
  const fallidos = results.filter((r) => !r.passed);
  if (fallidos.length === 0) return;
  titulo("DETALLE DE ESCENARIOS QUE FALLAN");
  for (const r of fallidos) {
    console.log(`\n[${r.id}] ${r.nombre}`);
    const sc = SCENARIOS.find((s) => s.id === r.id);
    if (sc) {
      console.log(`  Objetivo esperado: ${sc.expected_objective}`);
      console.log(`  Acción esperada:   ${sc.expected_next_action_category}`);
    }
    for (const f of r.failures) console.log(`  - ${f}`);
    if (sc && sc.forbidden.length > 0) {
      console.log(`  Prohibido en este escenario: ${sc.forbidden.join("; ")}`);
    }
  }
}

function tablaRegresiones(checks: RegressionCheck[]): void {
  titulo("CHEQUEOS DE REGRESIÓN");
  for (const c of checks) {
    const estado = c.passed ? "OK   " : isPending(c) ? "PEND " : "FALLA";
    console.log(`${estado} ${c.name}`);
    console.log(`      ${c.detail}`);
  }
}

function main(): void {
  titulo("EVALUACIÓN DE RUTEO DE AGENTES");
  console.log(`Escenarios: ${SCENARIOS.length} · sin tokens, sin base de datos, sin red`);
  console.log(`Contrato de RoutingResult observado: ${SHAPE_LABEL[observedRoutingShape()]}`);
  console.log("");

  const results = runRoutingEval();
  tablaEscenarios(results);
  detalleFallos(results);

  const checks = runRegressionChecks();
  tablaRegresiones(checks);

  const okEsc = results.filter((r) => r.passed).length;
  const pendientes = checks.filter(isPending);
  const ejecutables = checks.filter((c) => !isPending(c));
  const okChk = ejecutables.filter((c) => c.passed).length;

  titulo("RESUMEN");
  console.log(`Escenarios: ${okEsc}/${results.length} OK`);
  console.log(
    `Regresiones: ${okChk}/${ejecutables.length} OK` +
      (pendientes.length > 0 ? ` · ${pendientes.length} PENDIENTE (dependen de otro módulo)` : "")
  );

  const fallaTodo = okEsc !== results.length || okChk !== ejecutables.length;
  console.log(`RESULTADO: ${fallaTodo ? "FALLA" : "PASA"}`);
  process.exit(fallaTodo ? 1 : 0);
}

main();

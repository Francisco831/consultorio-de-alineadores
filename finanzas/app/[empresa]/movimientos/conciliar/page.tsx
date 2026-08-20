import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { ConciliarAcciones, SugerirBoton } from "@/components/movimientos/conciliar-acciones";

const ESTADOS: Array<{ key: string; label: string }> = [
  { key: "suggested", label: "Posible" },
  { key: "pending", label: "Pendiente" },
  { key: "unidentified", label: "No identificado" },
  { key: "matched", label: "Conciliado" },
  { key: "duplicate", label: "Duplicado" },
];

export default async function ConciliarPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ e?: string }>;
}) {
  const { empresa } = await params;
  const { e = "suggested" } = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  // conteos por estado con count exact (PostgREST corta los SELECT en 1.000
  // filas sin avisar: contar en JS mentiría)
  const conteoPorEstado = Promise.all(
    ESTADOS.map(async (est) => {
      const { count } = await supabase
        .from("statement_lines")
        .select("id", { count: "exact", head: true })
        .eq("company_id", ctx.companyId)
        .eq("match_status", est.key);
      return [est.key, count ?? 0] as const;
    })
  );
  const [{ data: lineas }, conteos, { data: categorias }] = await Promise.all([
    supabase
      .from("statement_lines")
      .select("id, posted_on, amount, currency, description_raw, counterparty_raw, match_status, match_score, match_method, account:accounts(name)")
      .eq("company_id", ctx.companyId)
      .eq("match_status", e)
      .order("posted_on", { ascending: false })
      .limit(200),
    conteoPorEstado,
    supabase
      .from("categories")
      .select("id, name, flow")
      .eq("company_id", ctx.companyId)
      .eq("is_active", true)
      .order("name"),
  ]);

  // sugerencias de las líneas visibles
  const ids = (lineas ?? []).map((l) => l.id);
  const { data: sugerencias } = ids.length
    ? await supabase
        .from("match_suggestions")
        .select("statement_line_id, score, method, movement:movements(id, occurred_on, amount, currency, description, counterparty:counterparties(display_name))")
        .in("statement_line_id", ids)
    : { data: [] };
  type Sug = NonNullable<typeof sugerencias>[number];
  const porLinea = new Map<string, Sug[]>();
  for (const s of (sugerencias ?? []) as Sug[]) {
    if (!porLinea.has(s.statement_line_id)) porLinea.set(s.statement_line_id, []);
    porLinea.get(s.statement_line_id)!.push(s);
  }

  const counts = new Map<string, number>(conteos);

  return (
    <div className="mx-auto max-w-[1200px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Conciliación</h1>
        <SugerirBoton empresa={ctx.config.slug} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {ESTADOS.map((est) => (
          <Link
            key={est.key}
            href={`/${empresa}/movimientos/conciliar?e=${est.key}`}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              e === est.key
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-accent"
            )}
          >
            {est.label} · {counts.get(est.key) ?? 0}
          </Link>
        ))}
      </div>

      <div className="space-y-2">
        {(lineas ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
            {e === "suggested"
              ? "Sin sugerencias pendientes. Importá un extracto o tocá “Buscar coincidencias”."
              : "Nada en este estado."}
          </div>
        ) : (
          (lineas ?? []).map((l) => {
            const sugs = porLinea.get(l.id) ?? [];
            const monto = Number(l.amount);
            const acc = (l.account as { name?: string } | null)?.name;
            return (
              <div key={l.id} className="grid gap-3 rounded-xl border bg-card p-4 shadow-sm md:grid-cols-[1fr_auto_1fr]">
                {/* izquierda: la línea del extracto */}
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Extracto · {acc}
                  </div>
                  <div className="mt-1 truncate text-sm font-medium">
                    {l.counterparty_raw || l.description_raw || "—"}
                  </div>
                  <div className="fig mt-0.5 text-xs text-muted-foreground">
                    {formatDateShort(l.posted_on, locale)} ·{" "}
                    <span className={cn("font-semibold", monto < 0 && "text-red-500")}>
                      {monto < 0 ? "−" : ""}{formatMoney(Math.abs(monto), l.currency, locale)}
                    </span>
                  </div>
                </div>
                {/* centro: estado */}
                <div className="flex items-center justify-center">
                  {l.match_score != null ? (
                    <span className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      Number(l.match_score) >= 0.8
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    )}>
                      {(Number(l.match_score) * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">·</span>
                  )}
                </div>
                {/* derecha: candidato + acciones */}
                <div className="min-w-0">
                  {sugs.length ? (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {sugs.length > 1 ? `Agrupado (${sugs.length} movimientos)` : "Movimiento propuesto"}
                      </div>
                      {sugs.map((s, i) => {
                        const m = s.movement as unknown as {
                          occurred_on: string; amount: number; currency: string;
                          description: string | null;
                          counterparty: { display_name?: string } | null;
                        } | null;
                        if (!m) return null;
                        return (
                          <div key={i} className="mt-1 truncate text-sm">
                            <span className="font-medium">
                              {m.counterparty?.display_name || m.description || "—"}
                            </span>{" "}
                            <span className="fig text-xs text-muted-foreground">
                              {formatDateShort(m.occurred_on, locale)} · {formatMoney(Number(m.amount), m.currency, locale)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">Sin candidato</div>
                  )}
                  <ConciliarAcciones
                    empresa={ctx.config.slug}
                    lineaId={l.id}
                    estado={l.match_status}
                    tieneSugerencia={sugs.length > 0}
                    categorias={(categorias ?? []).filter((c) => (monto >= 0 ? c.flow === "income" : c.flow === "expense"))}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { ConfirmarLiquidacion } from "@/components/compromisos/liquidacion-controles";

type Totales = {
  ARS?: { collected?: number; ks_cost?: number; base?: number; due?: number; withdrawn?: number; balance?: number };
  USD?: { collected?: number; due?: number };
};

const ESTADO: Record<string, { label: string; clase: string }> = {
  draft: { label: "Borrador", clase: "bg-secondary text-secondary-foreground" },
  confirmed: { label: "Confirmada", clase: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  paid: { label: "Pagada", clase: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  void: { label: "Anulada", clase: "bg-muted text-muted-foreground line-through" },
};

export default async function LiquidacionesPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ p?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const { data: todas } = await supabase
    .from("professional_settlements")
    .select("id, period, status, pct, totals, payable_id, professional:counterparties(display_name)")
    .eq("company_id", ctx.companyId)
    .order("period", { ascending: false });

  const filas = todas ?? [];
  const periodos = [...new Set(filas.map((f) => f.period))].sort().reverse();
  const periodo = sp.p && periodos.includes(sp.p) ? sp.p : periodos[0];
  const delPeriodo = filas.filter((f) => f.period === periodo);

  const totalPeriodo = delPeriodo.reduce(
    (a, f) => a + Number((f.totals as Totales)?.ARS?.due ?? 0), 0
  );

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Liquidaciones de profesionales</h1>
        <p className="text-sm text-muted-foreground">
          40% de lo cobrado, neto del costo KS del tratamiento. Al confirmar, la
          liquidación pasa a “Por pagar” y el retiro se registra desde ahí.
        </p>
      </div>

      {periodos.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Todavía no hay liquidaciones calculadas.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {periodos.map((p) => (
              <a key={p} href={`/${empresa}/liquidaciones?p=${p}`}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  p === periodo ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-accent"
                )}>
                {p}
              </a>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Profesional</th>
                  <th className="px-2 py-2 text-right font-medium">Cobrado</th>
                  <th className="px-2 py-2 text-right font-medium">Costo KS</th>
                  <th className="px-2 py-2 text-right font-medium">Base</th>
                  <th className="px-2 py-2 text-right font-medium">Liquidación</th>
                  <th className="px-2 py-2 text-right font-medium">Retiros</th>
                  <th className="px-2 py-2 text-right font-medium">Saldo</th>
                  <th className="px-2 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {delPeriodo.map((f) => {
                  const t = (f.totals as Totales) ?? {};
                  const ars = t.ARS ?? {};
                  const nombre = (f.professional as unknown as { display_name?: string } | null)?.display_name ?? "—";
                  const est = ESTADO[f.status] ?? ESTADO.draft;
                  return (
                    <tr key={f.id} className="border-b last:border-0">
                      <td className="px-4 py-2.5 font-medium">{nombre}</td>
                      <td className="fig px-2 py-2.5 text-right">
                        {formatMoney(ars.collected ?? 0, "ARS", locale)}
                        {t.USD?.collected ? (
                          <div className="text-[11px] text-muted-foreground">
                            + {formatMoney(t.USD.collected, "USD", locale)}
                          </div>
                        ) : null}
                      </td>
                      <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                        −{formatMoney(ars.ks_cost ?? 0, "ARS", locale)}
                      </td>
                      <td className="fig px-2 py-2.5 text-right">{formatMoney(ars.base ?? 0, "ARS", locale)}</td>
                      <td className="fig px-2 py-2.5 text-right font-semibold">
                        {formatMoney(ars.due ?? 0, "ARS", locale)}
                        <div className="text-[10px] font-normal text-muted-foreground">{Number(f.pct)}%</div>
                      </td>
                      <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                        {formatMoney(ars.withdrawn ?? 0, "ARS", locale)}
                      </td>
                      <td className={cn("fig px-2 py-2.5 text-right font-medium",
                        Number(ars.balance ?? 0) < 0 && "text-red-600 dark:text-red-400")}>
                        {formatMoney(ars.balance ?? 0, "ARS", locale)}
                      </td>
                      <td className="px-2 py-2.5">
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", est.clase)}>
                          {est.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {f.status === "draft" && Number(ars.due ?? 0) > 0 ? (
                          <ConfirmarLiquidacion
                            empresa={ctx.config.slug}
                            settlementId={f.id}
                            profesional={nombre}
                            monto={Number(ars.due ?? 0)}
                            hoy={todayIn(ctx.config.timezone)}
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/40 font-semibold">
                  <td className="px-4 py-2.5">Total {periodo}</td>
                  <td colSpan={3} />
                  <td className="fig px-2 py-2.5 text-right">{formatMoney(totalPeriodo, "ARS", locale)}</td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Los saldos negativos son doctoras que ya retiraron más de lo que les
            correspondía ese mes: se compensan con el mes siguiente.
          </p>
        </>
      )}
    </div>
  );
}

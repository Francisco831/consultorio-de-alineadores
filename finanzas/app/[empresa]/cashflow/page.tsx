import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

type Tramo = {
  currency: string; dias: number; saldo: number;
  a_cobrar: number; a_pagar: number; fijos_estimados: number;
};

export default async function CashflowPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const [{ data: forecast }, { data: recurrentes }] = await Promise.all([
    supabase.from("v_cashflow_forecast").select("*")
      .eq("company_id", ctx.companyId).order("dias"),
    supabase.from("recurring_rules")
      .select("name, currency, amount_estimated, frequency, next_due_on")
      .eq("company_id", ctx.companyId).eq("active", true).order("next_due_on"),
  ]);

  const tramos = (forecast ?? []) as Tramo[];
  const monedas = [...new Set(tramos.map((t) => t.currency))]
    .sort((a, b) => ctx.config.monedas.indexOf(a) - ctx.config.monedas.indexOf(b));

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Cash flow proyectado</h1>
        <p className="text-sm text-muted-foreground">
          Saldo de hoy, más lo que está pactado cobrar, menos lo que está pactado pagar.
          Solo cuenta lo que tiene fecha: no adivina ingresos futuros.
        </p>
      </div>

      {monedas.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Sin cuentas activas para proyectar.
        </div>
      ) : (
        monedas.map((moneda) => {
          const filas = tramos.filter((t) => t.currency === moneda);
          const saldo = Number(filas[0]?.saldo ?? 0);
          return (
            <section key={moneda} className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {moneda}
                </h2>
                <span className="text-xs text-muted-foreground">
                  saldo hoy <span className="fig font-medium text-foreground">{formatMoney(saldo, moneda, locale)}</span>
                </span>
              </div>
              <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Tramo</th>
                      <th className="px-2 py-2 text-right font-medium">Entra</th>
                      <th className="px-2 py-2 text-right font-medium">Sale</th>
                      <th className="px-2 py-2 text-right font-medium">Fijos que vienen</th>
                      <th className="px-4 py-2 text-right font-medium">Caja proyectada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((t) => {
                      const fijos = Number(t.fijos_estimados ?? 0);
                      const proyectada = saldo + Number(t.a_cobrar) - Number(t.a_pagar) - fijos;
                      const negativa = proyectada < 0;
                      return (
                        <tr key={t.dias} className="border-b last:border-0">
                          <td className="px-4 py-2.5 font-medium">{t.dias} días</td>
                          <td className="fig px-2 py-2.5 text-right text-emerald-600 dark:text-emerald-400">
                            {Number(t.a_cobrar) > 0 ? `+${formatMoney(Number(t.a_cobrar), moneda, locale)}` : "—"}
                          </td>
                          <td className="fig px-2 py-2.5 text-right text-red-600 dark:text-red-400">
                            {Number(t.a_pagar) > 0 ? `−${formatMoney(Number(t.a_pagar), moneda, locale)}` : "—"}
                          </td>
                          <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                            {fijos > 0 ? `−${formatMoney(fijos, moneda, locale)}` : "—"}
                          </td>
                          <td className={cn("fig px-4 py-2.5 text-right font-semibold",
                            negativa && "text-red-600 dark:text-red-400")}>
                            {formatMoney(proyectada, moneda, locale)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filas.some((t) => saldo + Number(t.a_cobrar) - Number(t.a_pagar) - Number(t.fijos_estimados ?? 0) < 0) ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                  La caja en {moneda} se pone negativa dentro del horizonte proyectado.
                </p>
              ) : null}
            </section>
          );
        })
      )}

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Gastos fijos que vienen
          </h2>
          <Link href={`/${empresa}/pagar`} className="text-xs font-medium text-primary hover:underline">
            Por pagar →
          </Link>
        </div>
        {(recurrentes ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
            Sin pagos recurrentes cargados.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <tbody>
                {(recurrentes ?? []).map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-2 py-2.5 text-muted-foreground">
                      {r.frequency === "monthly" ? "mensual" : r.frequency}
                    </td>
                    <td className="fig px-2 py-2.5 text-muted-foreground">{r.next_due_on}</td>
                    <td className="fig px-4 py-2.5 text-right font-medium">
                      {formatMoney(Number(r.amount_estimated), r.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

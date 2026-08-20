import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { currentPeriodIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CargarPresupuesto } from "@/components/presupuesto/cargar-presupuesto";

type Fila = {
  period: string; category_id: string; category_name: string; flow: string;
  currency: string; presupuesto: number; real: number; diferencia: number;
  ejecutado_pct: number | null;
};

export default async function PresupuestoPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale, monedaPrincipal, timezone } = ctx.config;
  const periodo = /^\d{4}-\d{2}$/.test(sp.m ?? "") ? sp.m! : currentPeriodIn(timezone);

  const [{ data }, { data: categorias }] = await Promise.all([
    supabase.from("v_budget_vs_real").select("*")
      .eq("company_id", ctx.companyId).eq("period", periodo),
    supabase.from("categories").select("id, name, flow")
      .eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
  ]);

  const filas = ((data ?? []) as Fila[]).filter((f) => f.currency === monedaPrincipal);
  const egresos = filas.filter((f) => f.flow === "expense");
  const totalPres = egresos.reduce((a, f) => a + Number(f.presupuesto), 0);
  const totalReal = egresos.reduce((a, f) => a + Number(f.real), 0);

  return (
    <div className="mx-auto max-w-[1000px] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Presupuesto vs real</h1>
          <p className="text-sm text-muted-foreground">
            Cuánto pensabas gastar en cada cosa y cuánto llevás gastado, mes por mes.
          </p>
        </div>
        <CargarPresupuesto empresa={ctx.config.slug} periodo={periodo}
          categorias={categorias ?? []} moneda={monedaPrincipal} />
      </div>

      {filas.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed bg-card p-8 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">No hay presupuesto cargado para {periodo}.</p>
          <p>
            Cargá cuánto esperás gastar por categoría y la pantalla te muestra al
            instante cuánto llevás ejecutado y dónde te estás pasando.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Tarjeta titulo="Presupuestado" valor={formatMoney(totalPres, monedaPrincipal, locale)} />
            <Tarjeta titulo="Gastado" valor={formatMoney(totalReal, monedaPrincipal, locale)}
              nota={totalPres > 0 ? `${((totalReal / totalPres) * 100).toFixed(0)}% ejecutado` : ""} />
            <Tarjeta titulo="Diferencia" destacado
              valor={formatMoney(totalPres - totalReal, monedaPrincipal, locale)}
              nota={totalReal > totalPres ? "te pasaste" : "te queda margen"} />
          </div>

          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Categoría</th>
                  <th className="px-2 py-2 text-right font-medium">Presupuesto</th>
                  <th className="px-2 py-2 text-right font-medium">Real</th>
                  <th className="px-2 py-2 text-right font-medium">Diferencia</th>
                  <th className="px-4 py-2 font-medium">Ejecutado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => {
                  const pct = f.ejecutado_pct == null ? 0 : Number(f.ejecutado_pct);
                  const excedido = pct > 100;
                  return (
                    <tr key={f.category_id} className="border-b last:border-0">
                      <td className="px-4 py-2.5 font-medium">{f.category_name}</td>
                      <td className="fig px-2 py-2.5 text-right">{formatMoney(Number(f.presupuesto), f.currency, locale)}</td>
                      <td className="fig px-2 py-2.5 text-right">{formatMoney(Number(f.real), f.currency, locale)}</td>
                      <td className={cn("fig px-2 py-2.5 text-right font-medium",
                        excedido && "text-red-600 dark:text-red-400")}>
                        {formatMoney(Number(f.presupuesto) - Number(f.real), f.currency, locale)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            <div className={cn("h-full", excedido ? "bg-red-500" : "bg-primary")}
                              style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                          <span className={cn("fig w-12 text-right text-xs",
                            excedido ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Tarjeta({ titulo, valor, nota, destacado }: {
  titulo: string; valor: string; nota?: string; destacado?: boolean;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 shadow-sm", destacado && "border-primary/40")}>
      <div className="text-xs text-muted-foreground">{titulo}</div>
      <div className="fig mt-1 text-2xl font-semibold">{valor}</div>
      {nota ? <div className="mt-0.5 text-[11px] text-muted-foreground">{nota}</div> : null}
    </div>
  );
}

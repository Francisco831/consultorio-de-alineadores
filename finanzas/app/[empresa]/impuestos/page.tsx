import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort, todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { NuevaObligacion, MandarAPagar } from "@/components/compromisos/impuestos-controles";

type Obligacion = {
  id: string; period: string; due_on: string; amount_estimated: number | null;
  amount_final: number | null; status: string; payable_id: string | null;
  tax: { name: string; jurisdiction: string } | null;
};

const ESTADO: Record<string, { label: string; clase: string }> = {
  estimated: { label: "Estimado", clase: "bg-secondary text-secondary-foreground" },
  final: { label: "Calculado", clase: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  paid: { label: "Pagado", clase: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  void: { label: "Anulado", clase: "bg-muted text-muted-foreground line-through" },
};

export default async function ImpuestosPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;
  const hoy = todayIn(ctx.config.timezone);

  const { data } = await supabase
    .from("tax_obligations")
    .select("id, period, due_on, amount_estimated, amount_final, status, payable_id, tax:taxes(name, jurisdiction)")
    .eq("company_id", ctx.companyId)
    .order("due_on", { ascending: false });

  const obligaciones = (data ?? []) as unknown as Obligacion[];
  const pendientes = obligaciones.filter((o) => o.status !== "paid" && o.status !== "void");
  const diasHasta = (f: string) => Math.round((Date.parse(f) - Date.parse(hoy)) / 86400000);

  return (
    <div className="mx-auto max-w-[1000px] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Impuestos</h1>
          <p className="text-sm text-muted-foreground">
            Calendario fiscal de {ctx.config.nombre}. Al mandar una obligación a
            pagar entra en la bandeja junto al resto de los vencimientos.
          </p>
        </div>
        <NuevaObligacion empresa={ctx.config.slug} hoy={hoy} />
      </div>

      {obligaciones.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed bg-card p-8 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Sin obligaciones cargadas.</p>
          <p>
            {empresa === "ar"
              ? "Cargá IVA, Ganancias, IIBB, F.931 y lo que pague el consultorio, con su vencimiento."
              : "Cargá ISR, IVA, IMSS y lo que declare GyG, con su fecha de vencimiento."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Impuesto</th>
                <th className="px-2 py-2 font-medium">Período</th>
                <th className="px-2 py-2 font-medium">Vence</th>
                <th className="px-2 py-2 text-right font-medium">Monto</th>
                <th className="px-2 py-2 font-medium">Estado</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {obligaciones.map((o) => {
                const dias = diasHasta(o.due_on);
                const monto = o.amount_final ?? o.amount_estimated;
                const est = ESTADO[o.status] ?? ESTADO.estimated;
                const urgente = o.status !== "paid" && dias <= 7;
                return (
                  <tr key={o.id} className="border-b last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{o.tax?.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{o.tax?.jurisdiction}</span>
                    </td>
                    <td className="fig px-2 py-2.5 text-muted-foreground">{o.period}</td>
                    <td className="fig px-2 py-2.5">
                      {formatDateShort(o.due_on, locale)}
                      {urgente ? (
                        <span className={cn("ml-2 text-[11px] font-medium",
                          dias < 0 ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")}>
                          {dias < 0 ? `vencido hace ${-dias}d` : dias === 0 ? "vence hoy" : `en ${dias}d`}
                        </span>
                      ) : null}
                    </td>
                    <td className="fig px-2 py-2.5 text-right font-medium">
                      {monto != null ? formatMoney(Number(monto), ctx.config.monedaPrincipal, locale) : "—"}
                      {o.amount_final == null && o.amount_estimated != null ? (
                        <div className="text-[10px] font-normal text-muted-foreground">estimado</div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", est.clase)}>
                        {est.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!o.payable_id && o.status !== "paid" && monto != null ? (
                        <MandarAPagar empresa={ctx.config.slug} obligacionId={o.id} />
                      ) : o.payable_id ? (
                        <span className="text-[11px] text-muted-foreground">en Por pagar</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pendientes.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {pendientes.length} obligación(es) sin pagar.
        </p>
      ) : null}
    </div>
  );
}

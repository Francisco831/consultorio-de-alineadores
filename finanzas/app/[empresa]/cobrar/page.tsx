import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort, todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CobrarBoton, NuevaDeudaClienteDialog } from "@/components/compromisos/cobrar-controles";

type Aging = {
  id: string; counterparty_name: string; concept: string; currency: string;
  amount: number; paid: number; balance: number; due_on: string | null;
  status: string; bucket: string; days_overdue: number;
};

const BUCKETS: Array<{ key: string; titulo: string; tono?: string }> = [
  { key: "d60_mas", titulo: "Más de 60 días", tono: "text-red-600 dark:text-red-400" },
  { key: "d31_60", titulo: "31 a 60 días", tono: "text-red-600 dark:text-red-400" },
  { key: "d16_30", titulo: "16 a 30 días", tono: "text-amber-600 dark:text-amber-400" },
  { key: "d8_15", titulo: "8 a 15 días", tono: "text-amber-600 dark:text-amber-400" },
  { key: "d1_7", titulo: "1 a 7 días", tono: "text-amber-600 dark:text-amber-400" },
  { key: "a_vencer", titulo: "A vencer" },
  { key: "sin_fecha", titulo: "Sin fecha de vencimiento" },
];

export default async function CobrarPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const [{ data: filas }, { data: cuentas }] = await Promise.all([
    supabase.from("v_receivables_aging").select("*")
      .eq("company_id", ctx.companyId).order("due_on", { nullsFirst: false }),
    supabase.from("accounts").select("id, name, currency")
      .eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
  ]);

  const deudas = (filas ?? []) as Aging[];
  const porMoneda = new Map<string, number>();
  for (const d of deudas) porMoneda.set(d.currency, (porMoneda.get(d.currency) ?? 0) + Number(d.balance));
  const vencido = deudas.filter((d) => d.bucket !== "a_vencer" && d.bucket !== "sin_fecha");

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Por cobrar</h1>
          <p className="text-sm text-muted-foreground">
            {deudas.length === 0
              ? "Sin deudas registradas."
              : `${deudas.length} pendientes · ${[...porMoneda].map(([m, v]) => formatMoney(v, m, locale)).join(" + ")}`}
            {vencido.length > 0 ? (
              <span className="ml-2 font-medium text-red-600 dark:text-red-400">
                {vencido.length} vencida{vencido.length > 1 ? "s" : ""}
              </span>
            ) : null}
          </p>
        </div>
        <NuevaDeudaClienteDialog
          empresa={ctx.config.slug}
          monedas={ctx.config.monedas}
          hoy={todayIn(ctx.config.timezone)}
        />
      </div>

      {deudas.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-dashed bg-card p-8 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Todavía no hay deudas cargadas.</p>
          <p>
            Acá vas a ver quién te debe y desde cuándo, con el aging por tramos.
            Cuando cargues un tratamiento en cuotas, cada cuota aparece con su
            vencimiento y podés cobrarla de a una.
          </p>
          <p className="text-xs">
            Esto arranca vacío a propósito: el histórico no dice cuánto quedó pendiente
            de cada paciente —las cuotas anteriores a enero no están en la caja— y
            estimarlo habría inventado deuda que no existe.
          </p>
        </div>
      ) : (
        BUCKETS.map((b) => {
          const items = deudas.filter((d) => d.bucket === b.key);
          if (!items.length) return null;
          const subtotal = new Map<string, number>();
          for (const i of items) subtotal.set(i.currency, (subtotal.get(i.currency) ?? 0) + Number(i.balance));
          return (
            <section key={b.key}>
              <h2 className={cn("mb-2 flex items-baseline justify-between text-sm font-semibold uppercase tracking-wide", b.tono ?? "text-muted-foreground")}>
                <span>{b.titulo} · {items.length}</span>
                <span className="fig font-medium normal-case">
                  {[...subtotal].map(([m, v]) => formatMoney(v, m, locale)).join(" + ")}
                </span>
              </h2>
              <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
                <table className="w-full text-[13px]">
                  <tbody>
                    {items.map((d) => (
                      <tr key={d.id} className="border-b last:border-0">
                        <td className="w-20 px-4 py-2.5 fig text-muted-foreground">
                          {d.due_on ? formatDateShort(d.due_on, locale) : "—"}
                        </td>
                        <td className="px-2 py-2.5">
                          <span className="font-medium">{d.counterparty_name}</span>
                          <span className="ml-2 text-muted-foreground">{d.concept}</span>
                          {d.days_overdue > 0 ? (
                            <span className="ml-2 text-[11px] text-red-600 dark:text-red-400">
                              {d.days_overdue} días
                            </span>
                          ) : null}
                        </td>
                        <td className="fig px-2 py-2.5 text-right font-medium">
                          {formatMoney(Number(d.balance), d.currency, locale)}
                          {Number(d.paid) > 0 ? (
                            <div className="text-[11px] font-normal text-muted-foreground">
                              cobrado {formatMoney(Number(d.paid), d.currency, locale)}
                            </div>
                          ) : null}
                        </td>
                        <td className="w-28 px-4 py-2.5 text-right">
                          <CobrarBoton
                            empresa={ctx.config.slug}
                            receivableId={d.id}
                            concepto={`${d.counterparty_name} · ${d.concept}`}
                            saldo={Number(d.balance)}
                            currency={d.currency}
                            cuentas={(cuentas ?? []).filter((c) => c.currency === d.currency)}
                            hoy={todayIn(ctx.config.timezone)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

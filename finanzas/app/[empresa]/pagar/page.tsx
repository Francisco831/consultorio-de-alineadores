import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort, todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { PagarBoton, NuevaDeudaDialog } from "@/components/compromisos/pagar-controles";

type Bucket = {
  id: string; concept: string; source: string; counterparty_name: string | null;
  category_name: string | null; currency: string; amount: number; paid: number;
  balance: number; due_on: string; status: string; bucket: string; days_to_due: number;
};

const GRUPOS: Array<{ key: string; titulo: string; tono?: string }> = [
  { key: "vencido", titulo: "Vencidos", tono: "text-red-600 dark:text-red-400" },
  { key: "hoy", titulo: "Hoy" },
  { key: "semana", titulo: "Esta semana" },
  { key: "d15", titulo: "Próximos 15 días" },
  { key: "d30", titulo: "Próximos 30 días" },
  { key: "despues", titulo: "Más adelante" },
];

const ORIGEN: Record<string, string> = {
  manual: "", recurring: "recurrente", tax: "impuesto",
  payroll: "sueldos", purchase: "compra", settlement: "liquidación",
};

export default async function PagarPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const [{ data: filas }, { data: cuentas }, { data: categorias }] = await Promise.all([
    supabase.from("v_payables_buckets").select("*")
      .eq("company_id", ctx.companyId).order("due_on"),
    supabase.from("accounts").select("id, name, currency")
      .eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    supabase.from("categories").select("id, name")
      .eq("company_id", ctx.companyId).eq("flow", "expense").eq("is_active", true).order("name"),
  ]);

  const pendientes = (filas ?? []) as Bucket[];
  const porMoneda = new Map<string, number>();
  for (const p of pendientes) {
    porMoneda.set(p.currency, (porMoneda.get(p.currency) ?? 0) + Number(p.balance));
  }
  const vencidos = pendientes.filter((p) => p.bucket === "vencido");

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Por pagar</h1>
          <p className="text-sm text-muted-foreground">
            {pendientes.length === 0
              ? "Sin deudas pendientes."
              : `${pendientes.length} pendientes · ${[...porMoneda]
                  .map(([m, v]) => formatMoney(v, m, locale))
                  .join(" + ")}`}
            {vencidos.length > 0 ? (
              <span className="ml-2 font-medium text-red-600 dark:text-red-400">
                {vencidos.length} vencida{vencidos.length > 1 ? "s" : ""}
              </span>
            ) : null}
          </p>
        </div>
        <NuevaDeudaDialog
          empresa={ctx.config.slug}
          monedas={ctx.config.monedas}
          categorias={categorias ?? []}
          hoy={todayIn(ctx.config.timezone)}
        />
      </div>

      {pendientes.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Acá van a aparecer los alquileres, impuestos, sueldos y facturas de proveedores
          antes de que venzan. Al marcar una como pagada se genera el egreso solo.
        </div>
      ) : (
        GRUPOS.map((g) => {
          const items = pendientes.filter((p) => p.bucket === g.key);
          if (!items.length) return null;
          return (
            <section key={g.key}>
              <h2 className={cn("mb-2 text-sm font-semibold uppercase tracking-wide", g.tono ?? "text-muted-foreground")}>
                {g.titulo} · {items.length}
              </h2>
              <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
                <table className="w-full text-[13px]">
                  <tbody>
                    {items.map((p) => (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="w-20 px-4 py-2.5 text-muted-foreground fig">
                          {formatDateShort(p.due_on, locale)}
                        </td>
                        <td className="px-2 py-2.5">
                          <span className="font-medium">{p.concept}</span>
                          {ORIGEN[p.source] ? (
                            <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase text-secondary-foreground">
                              {ORIGEN[p.source]}
                            </span>
                          ) : null}
                          {p.counterparty_name ? (
                            <span className="ml-2 text-muted-foreground">{p.counterparty_name}</span>
                          ) : null}
                        </td>
                        <td className="fig px-2 py-2.5 text-right font-medium">
                          {formatMoney(Number(p.balance), p.currency, locale)}
                          {Number(p.paid) > 0 ? (
                            <div className="text-[11px] font-normal text-muted-foreground">
                              pagado {formatMoney(Number(p.paid), p.currency, locale)} de{" "}
                              {formatMoney(Number(p.amount), p.currency, locale)}
                            </div>
                          ) : null}
                        </td>
                        <td className="w-32 px-4 py-2.5 text-right">
                          <PagarBoton
                            empresa={ctx.config.slug}
                            payableId={p.id}
                            concepto={p.concept}
                            saldo={Number(p.balance)}
                            currency={p.currency}
                            cuentas={(cuentas ?? []).filter((c) => c.currency === p.currency)}
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

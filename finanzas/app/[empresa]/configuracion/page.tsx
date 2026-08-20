import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { CuentaDialog } from "@/components/config/cuenta-dialog";

const TIPO_LABEL: Record<string, string> = {
  bank: "Banco", mercadopago: "Mercado Pago", cash: "Efectivo", external: "Externa",
};

export default async function ConfiguracionPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { data: balances } = await supabase
    .from("v_account_balances")
    .select("*")
    .eq("company_id", ctx.companyId)
    .order("name");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Configuración</h1>
          <p className="text-sm text-muted-foreground">
            Cuentas de {ctx.config.nombre} ·{" "}
            <Link href={`/${empresa}/configuracion/categorias`} className="text-primary hover:underline">
              ver categorías →
            </Link>
          </p>
        </div>
        <CuentaDialog empresa={ctx.config.slug} monedas={ctx.config.monedas} />
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Cuenta</th>
              <th className="px-2 py-2 font-medium">Tipo</th>
              <th className="px-2 py-2 font-medium">Moneda</th>
              <th className="px-2 py-2 text-right font-medium">Saldo</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {(balances ?? []).map((c) => (
              <tr key={c.account_id} className={`border-b last:border-0 ${!c.is_active ? "opacity-50" : ""}`}>
                <td className="px-4 py-2.5 font-medium">
                  {c.name}
                  {!c.include_in_totals ? (
                    <span className="ml-2 text-[10px] uppercase text-muted-foreground">no suma</span>
                  ) : null}
                </td>
                <td className="px-2 py-2.5 text-muted-foreground">{TIPO_LABEL[c.type] ?? c.type}</td>
                <td className="px-2 py-2.5 text-muted-foreground">{c.currency}</td>
                <td className="fig px-2 py-2.5 text-right font-medium">
                  {formatMoney(Number(c.balance), c.currency, ctx.config.locale)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <CuentaDialog
                    empresa={ctx.config.slug}
                    monedas={ctx.config.monedas}
                    cuenta={{
                      id: c.account_id, name: c.name, type: c.type, currency: c.currency,
                      includeInTotals: c.include_in_totals, isActive: c.is_active,
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

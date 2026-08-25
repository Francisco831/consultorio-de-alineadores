import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { todayIn } from "@/lib/dates";
import { CuentaDialog } from "@/components/config/cuenta-dialog";
import { VigenciaPrecios, type PrecioFila } from "@/components/config/vigencia-precios";
import { ProfesionalDialog } from "@/components/config/profesional-dialog";

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
  // v_account_balances no expone bank_name (0009_vistas.sql), y sin ese dato el
  // formulario de edición nacía vacío y la acción lo guardaba en null: editar
  // cualquier cosa de una cuenta le borraba el banco.
  const [{ data: balances }, { data: cuentasRaw }, { data: preciosRaw }, { data: profsRaw }] = await Promise.all([
    supabase.from("v_account_balances").select("*")
      .eq("company_id", ctx.companyId).order("name"),
    supabase.from("accounts").select("id, bank_name").eq("company_id", ctx.companyId),
    // Lo que el consultorio le paga a KS por cada tratamiento. Cada caso paga la
    // lista vigente cuando ENTRÓ, así que las viejas siguen vivas y se muestran.
    supabase.from("ks_price_list")
      .select("valid_from, audience, scope, arcades, list_price, discount_pct")
      .eq("company_id", ctx.companyId).order("valid_from", { ascending: false }),
    supabase.from("professionals")
      .select("counterparty_id, settlement_pct, settles_separately, active, cp:counterparties!inner(display_name)")
      .eq("company_id", ctx.companyId),
  ]);
  const bancoPorCuenta = new Map(
    (cuentasRaw ?? []).map((a) => [a.id as string, (a.bank_name as string | null) ?? null])
  );

  // Las listas agrupadas por vigencia, de la más nueva a la más vieja.
  const porVigencia = new Map<string, PrecioFila[]>();
  for (const r of preciosRaw ?? []) {
    const v = r.valid_from as string;
    if (!porVigencia.has(v)) porVigencia.set(v, []);
    porVigencia.get(v)!.push({
      audience: r.audience as string, scope: r.scope as string,
      arcades: Number(r.arcades), listPrice: Number(r.list_price),
      discountPct: Number(r.discount_pct),
    });
  }
  const vigencias = [...porVigencia].map(([validFrom, filas]) => ({ validFrom, filas }));

  const profesionales = (profsRaw ?? []).map((p) => ({
    id: p.counterparty_id as string,
    nombre: (p.cp as unknown as { display_name: string }).display_name,
    pct: Number(p.settlement_pct),
    cuentaPropia: Boolean(p.settles_separately),
    activa: Boolean(p.active),
  })).sort((a, b) => a.nombre.localeCompare(b.nombre));

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
                      bankName: bancoPorCuenta.get(c.account_id) ?? null,
                      includeInTotals: c.include_in_totals, isActive: c.is_active,
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {vigencias.length ? (
        <div className="space-y-2">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="font-medium">Listas de precios KS</h2>
              <p className="text-sm text-muted-foreground">
                Lo que el consultorio le paga a la fábrica. Cada caso paga la
                lista vigente cuando entró: las viejas no se tocan.
              </p>
            </div>
            <VigenciaPrecios
              empresa={ctx.config.slug}
              base={vigencias[0].filas}
              validFrom={todayIn(ctx.config.timezone)}
              esNueva
            />
          </div>
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Vigente desde</th>
                  <th className="px-2 py-2 font-medium">Precios</th>
                  <th className="px-2 py-2 text-right font-medium">Full 2 adultos</th>
                  <th className="px-2 py-2 text-right font-medium">Descuento</th>
                  <th className="px-4 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {vigencias.map((v) => {
                  const full2 = v.filas.find((f) => f.audience === "adultos" && f.scope === "full" && f.arcades === 2);
                  return (
                    <tr key={v.validFrom} className="border-b last:border-0">
                      <td className="fig px-4 py-2.5 font-medium">{v.validFrom}</td>
                      <td className="px-2 py-2.5 text-muted-foreground">{v.filas.length}</td>
                      <td className="fig px-2 py-2.5 text-right">
                        {full2 ? formatMoney(full2.listPrice, ctx.config.monedaPrincipal, ctx.config.locale) : "—"}
                      </td>
                      <td className="fig px-2 py-2.5 text-right text-muted-foreground">−{v.filas[0]?.discountPct ?? 0}%</td>
                      <td className="px-4 py-2.5 text-right">
                        <VigenciaPrecios empresa={ctx.config.slug} base={v.filas}
                          validFrom={v.validFrom} esNueva={false} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {profesionales.length ? (
        <div className="space-y-2">
          <div>
            <h2 className="font-medium">Profesionales</h2>
            <p className="text-sm text-muted-foreground">
              Cuánto cobra cada una de lo que factura, neto del costo KS.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Profesional</th>
                  <th className="px-2 py-2 text-right font-medium">Liquidación</th>
                  <th className="px-2 py-2 font-medium">Cómo cobra</th>
                  <th className="px-4 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {profesionales.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-4 py-2.5 font-medium">
                      {p.nombre}
                      {!p.activa ? (
                        <span className="ml-2 text-[10px] uppercase text-muted-foreground">inactiva</span>
                      ) : null}
                    </td>
                    <td className="fig px-2 py-2.5 text-right">{p.pct}%</td>
                    <td className="px-2 py-2.5 text-muted-foreground">
                      {p.cuentaPropia ? "A cuenta propia" : "Se le liquida"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <ProfesionalDialog empresa={ctx.config.slug} counterpartyId={p.id}
                        nombre={p.nombre} pct={p.pct} cuentaPropia={p.cuentaPropia} activa={p.activa} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

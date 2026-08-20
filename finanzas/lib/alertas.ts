// Motor de alertas: el sistema mira los datos y avisa, en vez de esperar a que
// alguien se ponga a buscar.
//
// Se calculan EN EL MOMENTO, no hay tabla de alertas ni cron. Con este volumen
// son unas pocas consultas y siempre dicen la verdad de ahora; una tabla habría
// que refrescarla y podría quedar mintiendo hasta la próxima corrida.
//
// Regla de redacción: cada alerta dice el número y qué hacer. "Tus gastos
// subieron" no sirve; "el gasto de agosto va 34% arriba del promedio" sí.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatMoney } from "@/lib/money";
import { currentPeriodIn } from "@/lib/dates";
import type { EmpresaConfig } from "@/lib/empresas";

export type Alerta = {
  id: string;
  severidad: "critica" | "atencion" | "info";
  titulo: string;
  detalle?: string;
  href?: string;
};

type Ctx = { companyId: string; config: EmpresaConfig };

export async function calcularAlertas(
  supabase: SupabaseClient,
  ctx: Ctx
): Promise<Alerta[]> {
  const { locale, monedaPrincipal, slug, timezone } = ctx.config;
  const periodo = currentPeriodIn(timezone);
  const alertas: Alerta[] = [];
  const money = (n: number) => formatMoney(n, monedaPrincipal, locale);

  const [
    { data: resumen },
    { data: porPagar },
    { data: porCobrar },
    { data: cashflow },
    { data: gastoProveedor },
    { data: precios },
  ] = await Promise.all([
    supabase.from("v_monthly_summary").select("month, currency, income, expense")
      .eq("company_id", ctx.companyId).eq("currency", monedaPrincipal).order("month"),
    supabase.from("v_payables_buckets").select("bucket, currency, balance")
      .eq("company_id", ctx.companyId),
    supabase.from("v_receivables_aging").select("bucket, currency, balance, days_overdue")
      .eq("company_id", ctx.companyId),
    supabase.from("v_cashflow_forecast").select("currency, dias, saldo, a_cobrar, a_pagar, fijos_estimados")
      .eq("company_id", ctx.companyId).order("dias"),
    supabase.from("v_supplier_spend").select("supplier_name, currency, month, total")
      .eq("company_id", ctx.companyId).eq("currency", monedaPrincipal),
    supabase.from("v_product_prices").select("product_name, variacion_pct, precio_ultimo, currency, compras")
      .eq("company_id", ctx.companyId).gt("compras", 1),
  ]);

  // ---------- la caja se pone negativa ----------
  for (const t of cashflow ?? []) {
    const proyectada =
      Number(t.saldo) + Number(t.a_cobrar) - Number(t.a_pagar) - Number(t.fijos_estimados ?? 0);
    if (proyectada < 0) {
      alertas.push({
        id: `caja-${t.currency}`,
        severidad: "critica",
        titulo: `La caja en ${t.currency} se pone negativa en ${t.dias} días`,
        detalle: `Proyectada: ${formatMoney(proyectada, t.currency, locale)}`,
        href: `/${slug}/cashflow`,
      });
      break; // el tramo más cercano alcanza; los demás son la misma noticia
    }
  }

  // ---------- lo que ya venció ----------
  const vencidoPagar = (porPagar ?? []).filter((p) => p.bucket === "vencido");
  if (vencidoPagar.length) {
    const total = vencidoPagar.reduce((a, p) => a + Number(p.balance), 0);
    alertas.push({
      id: "pagar-vencido",
      severidad: "critica",
      titulo: `${vencidoPagar.length} pago(s) vencido(s) por ${money(total)}`,
      href: `/${slug}/pagar`,
    });
  }
  const vencidoCobrar = (porCobrar ?? []).filter((c) => Number(c.days_overdue) > 0);
  if (vencidoCobrar.length) {
    const total = vencidoCobrar.reduce((a, c) => a + Number(c.balance), 0);
    const peor = Math.max(...vencidoCobrar.map((c) => Number(c.days_overdue)));
    alertas.push({
      id: "cobrar-vencido",
      severidad: "atencion",
      titulo: `${vencidoCobrar.length} cobro(s) vencido(s) por ${money(total)}`,
      detalle: `El más atrasado lleva ${peor} días`,
      href: `/${slug}/cobrar`,
    });
  }

  // ---------- lo que vence esta semana ----------
  const semana = (porPagar ?? []).filter((p) => p.bucket === "hoy" || p.bucket === "semana");
  if (semana.length) {
    const total = semana.reduce((a, p) => a + Number(p.balance), 0);
    alertas.push({
      id: "pagar-semana",
      severidad: "atencion",
      titulo: `${money(total)} por pagar en los próximos 7 días`,
      detalle: `${semana.length} vencimiento(s)`,
      href: `/${slug}/pagar`,
    });
  }

  // ---------- el gasto del mes se disparó ----------
  const meses = (resumen ?? []).filter((r) => (r.expense ?? 0) > 0);
  const actual = meses.find((r) => r.month.slice(0, 7) === periodo);
  const previos = meses.filter((r) => r.month.slice(0, 7) < periodo).slice(-3);
  if (actual && previos.length >= 2) {
    const promedio = previos.reduce((a, r) => a + Number(r.expense), 0) / previos.length;
    const gasto = Number(actual.expense);
    if (promedio > 0 && gasto > promedio * 1.15) {
      alertas.push({
        id: "gasto-alto",
        severidad: "atencion",
        titulo: `El gasto de este mes va ${(((gasto / promedio) - 1) * 100).toFixed(0)}% arriba del promedio`,
        detalle: `${money(gasto)} contra ${money(promedio)} de los últimos ${previos.length} meses`,
        href: `/${slug}/costos`,
      });
    }
  }

  // ---------- un proveedor concentra demasiado ----------
  const anio = periodo.slice(0, 4);
  const porProveedor = new Map<string, number>();
  let totalGasto = 0;
  for (const g of gastoProveedor ?? []) {
    if (!String(g.month).startsWith(anio)) continue;
    porProveedor.set(g.supplier_name, (porProveedor.get(g.supplier_name) ?? 0) + Number(g.total));
    totalGasto += Number(g.total);
  }
  const top = [...porProveedor.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && totalGasto > 0 && top[1] / totalGasto >= 0.25) {
    alertas.push({
      id: "proveedor-concentrado",
      severidad: "info",
      titulo: `${top[0]} concentra el ${((top[1] / totalGasto) * 100).toFixed(0)}% de todo tu gasto`,
      detalle: `${money(top[1])} en ${anio}`,
      href: `/${slug}/proveedores`,
    });
  }

  // ---------- un producto aumentó fuerte ----------
  const subieron = (precios ?? [])
    .filter((p) => p.variacion_pct != null && Number(p.variacion_pct) >= 15)
    .sort((a, b) => Number(b.variacion_pct) - Number(a.variacion_pct));
  if (subieron.length) {
    const p = subieron[0];
    alertas.push({
      id: "precio-subio",
      severidad: "atencion",
      titulo: `${p.product_name} aumentó ${Number(p.variacion_pct).toFixed(0)}% desde la primera compra`,
      detalle: subieron.length > 1 ? `y ${subieron.length - 1} producto(s) más subieron 15% o más` : undefined,
      href: `/${slug}/compras?t=precios`,
    });
  }

  // ---------- trabajo pendiente del propio sistema ----------
  const pend = await contarPendientes(supabase, ctx);
  if (pend.conciliar > 0) {
    alertas.push({
      id: "conciliar",
      severidad: "info",
      titulo: `${pend.conciliar} línea(s) de extracto esperando conciliación`,
      href: `/${slug}/movimientos/conciliar`,
    });
  }
  if (pend.clasificar > 0) {
    alertas.push({
      id: "clasificar",
      severidad: "info",
      titulo: `${pend.clasificar} movimiento(s) sin medio de pago identificado`,
      detalle: "No suman a la caja hasta que se les asigne una cuenta",
      href: `/${slug}/movimientos?f=pendientes`,
    });
  }
  if (pend.liquidaciones > 0) {
    alertas.push({
      id: "liquidaciones",
      severidad: "info",
      titulo: `${pend.liquidaciones} liquidación(es) en borrador sin confirmar`,
      href: `/${slug}/liquidaciones`,
    });
  }

  const orden = { critica: 0, atencion: 1, info: 2 } as const;
  return alertas.sort((a, b) => orden[a.severidad] - orden[b.severidad]);
}

/** Cuenta de filas usando count exact (PostgREST corta los SELECT en 1.000). */
export async function contarPendientes(supabase: SupabaseClient, ctx: Ctx) {
  const [conciliar, clasificar, liquidaciones] = await Promise.all([
    supabase.from("statement_lines").select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId).in("match_status", ["suggested", "unidentified"]),
    supabase.from("movements").select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId).eq("status", "pending"),
    supabase.from("professional_settlements").select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId).eq("status", "draft"),
  ]);
  return {
    conciliar: conciliar.count ?? 0,
    clasificar: clasificar.count ?? 0,
    liquidaciones: liquidaciones.count ?? 0,
  };
}

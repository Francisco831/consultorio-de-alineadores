import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { currentPeriodIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CargarProduccion } from "@/components/costos/cargar-produccion";

// El menú de costos cambia según la empresa: México produce (costo por alineador),
// el consultorio opera (fijos vs variables). Son dos preguntas distintas y por eso
// dos modelos distintos, no uno genérico que no sirva para ninguna.

type Operativo = {
  month: string; currency: string; behavior: string;
  category_name: string | null; total: number;
};
type ProduccionMes = {
  period: string; aligners_produced: number; cases_shipped: number | null; notes: string | null;
};
type Produccion = {
  period: string; aligners_produced: number; currency: string;
  gasto_produccion: number; costo_por_alineador: number | null;
};

export default async function CostosPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale, monedaPrincipal } = ctx.config;
  const esMexico = ctx.config.slug === "mx";

  if (esMexico) {
    const [{ data: costos }, { data: meses }, { data: gastosRaw }] = await Promise.all([
      supabase.from("v_production_cost").select("*").eq("company_id", ctx.companyId).order("period"),
      supabase.from("production_months").select("period, aligners_produced, cases_shipped, notes")
        .eq("company_id", ctx.companyId).order("period"),
      supabase.from("movements")
        .select("occurred_on, amount, category:categories(name)")
        .eq("company_id", ctx.companyId).eq("kind", "expense").neq("status", "void")
        .limit(10000),
    ]);
    // La producción es la espina: se ve aunque todavía no haya gastos con los
    // que dividirla. Media respuesta cargada es mejor que una pantalla vacía.
    const costoPorPeriodo = new Map(((costos ?? []) as Produccion[]).map((c) => [c.period, c]));
    // Costo PLENO: todo el gasto del mes (estructura incluida) sobre lo producido.
    // La mercadería de reventa queda afuera: no es costo del alineador.
    const gastoTotalMes = new Map<string, number>();
    for (const m of gastosRaw ?? []) {
      if ((m.category as { name?: string } | null)?.name === "Scanners para reventa") continue;
      const p = String(m.occurred_on).slice(0, 7);
      gastoTotalMes.set(p, (gastoTotalMes.get(p) ?? 0) + Number(m.amount));
    }
    const filas = ((meses ?? []) as ProduccionMes[]).map((m) => {
      const gastoTotal = gastoTotalMes.get(m.period) ?? null;
      return {
        ...m, costo: costoPorPeriodo.get(m.period) ?? null,
        gastoTotal,
        costoPleno: gastoTotal != null && m.aligners_produced > 0
          ? gastoTotal / m.aligners_produced : null,
      };
    });
    const ultimo = filas[filas.length - 1];
    const hayGastos = costoPorPeriodo.size > 0;

    return (
      <div className="mx-auto max-w-[1000px] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{ctx.config.labelCostos}</h1>
            <p className="text-sm text-muted-foreground">
              Cuánto cuesta de verdad un alineador, en dos números: el del taller
              (gasto de producción ÷ producido) y el pleno (todo el gasto del mes
              ÷ producido) — el pleno es el que manda para poner precios.
            </p>
          </div>
          <CargarProduccion empresa={ctx.config.slug} periodo={currentPeriodIn(ctx.config.timezone)} />
        </div>

        {filas.length === 0 ? (
          <div className="space-y-2 rounded-xl border border-dashed bg-card p-8 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Falta el dato que no existe en ningún sistema: cuántos alineadores se produjeron.</p>
            <p>
              El CRM tiene casos, pero un caso no dice cuántos alineadores tiene. Cargá
              la producción del mes y el costo por alineador sale solo, cruzándolo contra
              los gastos de las categorías marcadas como producción.
            </p>
          </div>
        ) : (
          <>
            {!hayGastos ? (
              <div className="rounded-xl border border-dashed bg-card p-4 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Falta la otra mitad.</span>{" "}
                La producción está cargada, pero México no tiene ningún gasto en las
                categorías de producción (placas, resina, packaging, sueldos de producción,
                energía, mantenimiento). Hasta que entren, el costo unitario queda en —.
              </div>
            ) : null}
            {ultimo ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Tarjeta titulo="Costo pleno por alineador" nota={`${ultimo.period} · con estructura`} destacado
                  valor={ultimo.costoPleno != null
                    ? formatMoney(ultimo.costoPleno, monedaPrincipal, locale, { decimals: true })
                    : "—"} />
                <Tarjeta titulo="Costo de producción" nota={`${ultimo.period} · solo taller`}
                  valor={ultimo.costo?.costo_por_alineador != null
                    ? formatMoney(Number(ultimo.costo.costo_por_alineador), ultimo.costo.currency, locale, { decimals: true })
                    : "—"} />
                <Tarjeta titulo="Gasto de producción" nota={ultimo.period}
                  valor={ultimo.costo
                    ? formatMoney(Number(ultimo.costo.gasto_produccion), ultimo.costo.currency, locale)
                    : "—"} />
                <Tarjeta titulo="Alineadores del mes" nota={ultimo.period}
                  valor={ultimo.aligners_produced.toLocaleString(locale)} />
              </div>
            ) : null}
            <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Mes</th>
                    <th className="px-2 py-2 text-right font-medium">Alineadores</th>
                    <th className="px-2 py-2 text-right font-medium">Casos</th>
                    <th className="px-2 py-2 text-right font-medium">Alin/caso</th>
                    <th className="px-2 py-2 text-right font-medium">Gasto producción</th>
                    <th className="px-2 py-2 text-right font-medium">Costo producción</th>
                    <th className="px-2 py-2 text-right font-medium">Gasto total</th>
                    <th className="px-4 py-2 text-right font-medium">Costo pleno</th>
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f, i) => (
                    <tr key={i} className="border-b last:border-0" title={f.notes ?? undefined}>
                      <td className="px-4 py-2.5 font-medium">{f.period}</td>
                      <td className="fig px-2 py-2.5 text-right">{f.aligners_produced.toLocaleString(locale)}</td>
                      <td className="fig px-2 py-2.5 text-right text-muted-foreground">{f.cases_shipped?.toLocaleString(locale) ?? "—"}</td>
                      <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                        {f.cases_shipped ? (f.aligners_produced / f.cases_shipped).toFixed(1) : "—"}
                      </td>
                      <td className="fig px-2 py-2.5 text-right">
                        {f.costo ? formatMoney(Number(f.costo.gasto_produccion), f.costo.currency, locale) : "—"}
                      </td>
                      <td className="fig px-2 py-2.5 text-right">
                        {f.costo?.costo_por_alineador != null
                          ? formatMoney(Number(f.costo.costo_por_alineador), f.costo.currency, locale, { decimals: true })
                          : "—"}
                      </td>
                      <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                        {f.gastoTotal != null ? formatMoney(f.gastoTotal, monedaPrincipal, locale) : "—"}
                      </td>
                      <td className="fig px-4 py-2.5 text-right font-semibold">
                        {f.costoPleno != null
                          ? formatMoney(f.costoPleno, monedaPrincipal, locale, { decimals: true })
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Costo pleno = todo el gasto del mes (estructura incluida, sin la
              mercadería de reventa) dividido por los alineadores producidos. El de
              producción mide el taller; el pleno es el piso para pensar precios.
            </p>
          </>
        )}
      </div>
    );
  }

  // ---------- consultorio: fijos vs variables ----------
  const { data } = await supabase.from("v_operating_costs").select("*")
    .eq("company_id", ctx.companyId).eq("currency", monedaPrincipal).order("month");
  const filas = (data ?? []) as Operativo[];
  const meses = [...new Set(filas.map((f) => f.month.slice(0, 7)))].sort().reverse();
  const mes = sp.m && meses.includes(sp.m) ? sp.m : meses[0];
  const delMes = filas.filter((f) => f.month.slice(0, 7) === mes);

  const fijos = delMes.filter((f) => f.behavior === "fixed").reduce((a, f) => a + Number(f.total), 0);
  const variables = delMes.filter((f) => f.behavior === "variable").reduce((a, f) => a + Number(f.total), 0);
  const sinClasificar = delMes.filter((f) => f.behavior === "sin_clasificar").reduce((a, f) => a + Number(f.total), 0);
  const total = fijos + variables + sinClasificar;

  return (
    <div className="mx-auto max-w-[1000px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{ctx.config.labelCostos}</h1>
        <p className="text-sm text-muted-foreground">
          Qué te cuesta tener el consultorio abierto, separando lo que pagás sí o sí
          de lo que depende de cuánto trabajes.
        </p>
      </div>

      {meses.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Todavía no hay gastos cargados.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {meses.slice(0, 8).map((m) => (
              <a key={m} href={`/${empresa}/costos?m=${m}`}
                className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  m === mes ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-accent")}>
                {m}
              </a>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Tarjeta titulo="Costos fijos" valor={formatMoney(fijos, monedaPrincipal, locale)}
              nota={total > 0 ? `${((fijos / total) * 100).toFixed(0)}% del total` : ""} />
            <Tarjeta titulo="Costos variables" valor={formatMoney(variables, monedaPrincipal, locale)}
              nota={total > 0 ? `${((variables / total) * 100).toFixed(0)}% del total` : ""} />
            <Tarjeta titulo="Costo total del mes" valor={formatMoney(total, monedaPrincipal, locale)}
              nota={sinClasificar > 0 ? `incluye ${formatMoney(sinClasificar, monedaPrincipal, locale)} sin clasificar` : ""} destacado />
          </div>

          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Categoría</th>
                  <th className="px-2 py-2 font-medium">Tipo</th>
                  <th className="px-2 py-2 text-right font-medium">% del mes</th>
                  <th className="px-4 py-2 text-right font-medium">Importe</th>
                </tr>
              </thead>
              <tbody>
                {[...delMes].sort((a, b) => Number(b.total) - Number(a.total)).map((f, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-2.5 font-medium">{f.category_name ?? "(sin categoría)"}</td>
                    <td className="px-2 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium",
                        f.behavior === "fixed" ? "bg-secondary text-secondary-foreground"
                          : f.behavior === "variable" ? "bg-accent text-accent-foreground"
                          : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300")}>
                        {f.behavior === "fixed" ? "Fijo" : f.behavior === "variable" ? "Variable" : "Sin clasificar"}
                      </span>
                    </td>
                    <td className="fig px-2 py-2.5 text-right text-muted-foreground">
                      {total > 0 ? `${((Number(f.total) / total) * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="fig px-4 py-2.5 text-right font-medium">
                      {formatMoney(Number(f.total), monedaPrincipal, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sinClasificar > 0 ? (
            <p className="text-xs text-muted-foreground">
              Hay {formatMoney(sinClasificar, monedaPrincipal, locale)} en gastos sin categoría:
              clasificarlos es lo que hace que este corte sirva.
            </p>
          ) : null}
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

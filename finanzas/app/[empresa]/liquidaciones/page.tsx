import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { ConfirmarLiquidacion, ReabrirLiquidacion } from "@/components/compromisos/liquidacion-controles";
import { RecalcularBoton } from "@/components/liquidaciones/recalcular-boton";
import { ImputarCobro, DESTINO_CAJA, DESTINO_CASA } from "@/components/liquidaciones/imputar-cobro";
import { RevisadoCheck } from "@/components/liquidaciones/revisado-check";
import { EditarLinea, DeshacerLinea } from "@/components/liquidaciones/editar-linea";
import { AgregarLinea } from "@/components/liquidaciones/agregar-linea";
import { COMISION_POR_TRATAMIENTO } from "@/lib/liquidaciones/comision-claudia";
import { comisionClaudiaPorMes } from "@/lib/liquidaciones/comision-claudia-query";
import { periodoDeMovimiento, type MovimientoBase } from "@/lib/liquidaciones/recalcular";
import { FUENTE_TC, tablaTC, type Cotizacion } from "@/lib/fx";

type Totales = {
  ARS?: { collected?: number; ks_cost?: number; base?: number; due?: number; withdrawn?: number; balance?: number };
  // Desde el 25/8/26 las liquidaciones nuevas no tienen bucket USD: lo cobrado
  // en dólares entra pesificado al blue del día. Las CONGELADAS de antes sí lo
  // tienen y se siguen mostrando como se pagaron.
  USD?: { collected?: number; due?: number };
};

const ESTADO: Record<string, { label: string; clase: string }> = {
  draft: { label: "Borrador", clase: "bg-secondary text-secondary-foreground" },
  confirmed: { label: "Confirmada", clase: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  paid: { label: "Pagada", clase: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
  void: { label: "Anulada", clase: "bg-muted text-muted-foreground line-through" },
};

/** dd/mm de una fecha ISO. */
const dm = (f?: string | null) => (f ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : "—");

/** Mes anterior y siguiente de un período 'AAAA-MM' (ventana de movimientos). */
function ventana(periodo: string): { desde: string; hasta: string } {
  const [a, m] = periodo.split("-").map(Number);
  const iso = (y: number, mm: number) => `${y + Math.floor((mm - 1) / 12)}-${String(((mm - 1) % 12 + 12) % 12 + 1).padStart(2, "0")}`;
  return { desde: `${iso(a, m - 1)}-01`, hasta: `${iso(a, m + 1)}-31` };
}

export default async function LiquidacionesPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ p?: string; editar?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const { data: todas } = await supabase
    .from("professional_settlements")
    .select("id, period, status, pct, totals, payable_id, professional_id, professional:counterparties(display_name)")
    .eq("company_id", ctx.companyId)
    .order("period", { ascending: false });

  const filas = todas ?? [];
  const periodos = [...new Set(filas.map((f) => f.period))].sort().reverse();
  const periodo = sp.p && periodos.includes(sp.p) ? sp.p : periodos[0];
  // Las anuladas no se listan: son las que se quedaron sin ningún cobro detrás
  // (los que tenían se reimputaron). Mostrar sus totales viejos sería mentir.
  const delPeriodo = filas.filter((f) => f.period === periodo && f.status !== "void");

  // detalle línea por línea del período: cada cobro con su paciente y costo KS
  type Item = {
    settlement_id: string; movement_id: string; base_amount: number; ks_cost: number;
    currency: string; label: string | null;
    // amount/currency son los del MOVIMIENTO, no los del ítem: desde el 25/8/26
    // el ítem se guarda siempre en pesos, así que preguntarle a él "qué dice la
    // caja" contesta "$1.540.000" para un cobro que fue de US$ 1.000.
    movement: {
      occurred_on: string; amount: string | number; currency: string;
      counterparty: { display_name: string } | null;
    } | null;
  };
  const { data: itemsRaw } = delPeriodo.length
    ? await supabase
        .from("settlement_items")
        .select("settlement_id, movement_id, base_amount, ks_cost, currency, label, movement:movements(occurred_on, amount, currency, counterparty:counterparties(display_name))")
        .in("settlement_id", delPeriodo.map((f) => f.id))
        .limit(2000)
    : { data: [] };
  const itemsPorSet = new Map<string, Item[]>();
  for (const it of (itemsRaw ?? []) as unknown as Item[]) {
    if (!itemsPorSet.has(it.settlement_id)) itemsPorSet.set(it.settlement_id, []);
    itemsPorSet.get(it.settlement_id)!.push(it);
  }
  for (const arr of itemsPorSet.values()) {
    arr.sort((a, b) => (a.movement?.occurred_on ?? "").localeCompare(b.movement?.occurred_on ?? ""));
  }

  const totalPeriodo = delPeriodo.reduce(
    (a, f) => a + Number((f.totals as Totales)?.ARS?.due ?? 0), 0
  );

  // ---- a quién se le liquida cada cobro (correcciones a mano) ----
  // Coni también va en el selector (Pancho, 26/8/26): hay cobros que son de
  // ella y hay que poder decirlo. Va marcada como "cobra a cuenta propia"
  // porque imputarle un cobro lo saca de TODAS las liquidaciones y del total de
  // la casa — es una salida legítima, pero tiene que estar dicha en la opción y
  // no descubrirse después en un total que no cierra.
  const { data: profsRaw } = await supabase
    .from("professionals")
    .select("counterparty_id, active, settles_separately, cp:counterparties!inner(display_name)")
    .eq("company_id", ctx.companyId);
  const doctoras = (profsRaw ?? [])
    .filter((p) => p.active)
    .map((p) => ({
      id: p.counterparty_id as string,
      nombre: (p.cp as unknown as { display_name: string }).display_name,
      aparte: Boolean(p.settles_separately),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  // Lo que el último recálculo encontró mal (tabla settlement_issues, escrita
  // por el propio motor). Antes esto sólo lo veía quien corriera el script en
  // una terminal: un cobro sin costear entra con costo KS $0 y la doctora cobra
  // el 40% del BRUTO, sin que ninguna pantalla lo diga.
  const { data: issuesRaw } = await supabase
    .from("settlement_issues")
    .select("kind, period, professional, amount, currency, detail")
    .eq("company_id", ctx.companyId)
    .order("amount", { ascending: false, nullsFirst: false });
  type Issue = {
    kind: string; period: string | null; professional: string | null;
    amount: number | null; currency: string | null; detail: string;
  };
  const issues = (issuesRaw ?? []) as Issue[];
  const sinCostear = issues.filter((i) => i.kind === "sin_costear");
  const otrosIssues = issues.filter((i) => i.kind !== "sin_costear");
  // Los de una doctora que liquida por cuenta propia (Coni) no le cuestan plata
  // a Pancho: se muestran igual, pero el total que duele es el otro.
  const sinCostearPropios = sinCostear.filter((i) => i.professional !== "Coni");
  const totalSinCostear = sinCostearPropios.reduce((a, i) => a + Number(i.amount ?? 0), 0);

  const { data: impRaw } = await supabase
    .from("settlement_imputations")
    .select("movement_id, destino, professional_id, revisado")
    .eq("company_id", ctx.companyId);
  type Decidido = { destino: "caja" | "casa" | "profesional"; profesionalId: string | null; revisado: boolean };
  const decidido = new Map<string, Decidido>(
    (impRaw ?? []).map((i) => [i.movement_id as string, {
      destino: i.destino as Decidido["destino"],
      profesionalId: (i.professional_id as string | null) ?? null,
      revisado: Boolean(i.revisado),
    }])
  );
  /** Qué muestra el selector de una línea: uuid de doctora, "casa" o "caja". */
  const valorSelector = (movementId: string) => {
    const d = decidido.get(movementId);
    if (!d || d.destino === "caja") return DESTINO_CAJA;
    return d.destino === "casa" ? DESTINO_CASA : (d.profesionalId ?? DESTINO_CAJA);
  };

  // ---- los números puestos a mano (0030) ----
  // Viven aparte del resultado porque el resultado se reescribe entero en cada
  // recálculo. Acá se leen para dos cosas: pintar la línea corregida y armar el
  // panel de cambios a mano, que es por donde se vuelve atrás.
  const { data: ovRaw, error: errorOverrides } = await supabase
    .from("settlement_line_overrides")
    .select("movement_id, collected_ars, ks_cost_ars, reason, snapshot, created_at")
    .eq("company_id", ctx.companyId).eq("status", "active");
  type Snapshot = {
    fecha?: string; paciente?: string; doctora?: string; periodo?: string;
    monto_caja?: number; moneda?: string;
    cobrado_calculado?: number | null; costo_calculado?: number | null;
  };
  type Override = {
    movementId: string; cobradoArs: number | null; costoKsArs: number | null;
    motivo: string; snapshot: Snapshot; creadoEl: string;
  };
  const overrides = new Map<string, Override>(
    (ovRaw ?? []).map((o) => [o.movement_id as string, {
      movementId: o.movement_id as string,
      cobradoArs: o.collected_ars == null ? null : Number(o.collected_ars),
      costoKsArs: o.ks_cost_ars == null ? null : Number(o.ks_cost_ars),
      motivo: (o.reason as string) ?? "",
      snapshot: (o.snapshot ?? {}) as Snapshot,
      creadoEl: o.created_at as string,
    }])
  );
  const cambiosAMano = [...overrides.values()]
    .filter((o) => (o.snapshot.periodo ?? o.snapshot.fecha?.slice(0, 7)) === periodo)
    .sort((a, b) => (a.snapshot.fecha ?? "").localeCompare(b.snapshot.fecha ?? ""));

  // El modo edición no está escondido: está APAGADO. Se prende por la URL
  // (?editar=1) y no con un toggle de cliente, para que no quede prendido sin
  // que se note y para que un re-render no pueda cambiarlo solo.
  const editar = sp.editar === "1";
  // La caja Coni lleva contabilidad separada: un cobro que se agrega desde acá
  // es del consultorio, así que su cuenta no se ofrece.
  const { data: cuentasRaw } = editar
    ? await supabase.from("accounts")
        .select("id, name, currency, separate_books").eq("company_id", ctx.companyId)
        .eq("is_active", true).order("name")
    : { data: [] };
  const cuentas = (cuentasRaw ?? [])
    .filter((c) => !c.separate_books)
    .map((c) => ({
      id: c.id as string, nombre: c.name as string, moneda: c.currency as string,
    }));

  // Cobros del mes que NO se le liquidan a nadie: los que Pancho sacó de una
  // doctora y los que la caja nunca atribuyó. Se buscan en una ventana de ±1 mes
  // porque un cobro puede liquidar un período distinto del de su fecha (los
  // devengados de periodo_liquidacion_overrides.json; todos caen dentro del mes
  // anterior o el siguiente).
  const { desde, hasta } = ventana(periodo ?? "");
  const { data: movsVentana } = periodo
    ? await supabase
        .from("movements")
        .select("id, occurred_on, kind, amount, currency, meta, counterparties(display_name)")
        .eq("company_id", ctx.companyId).eq("kind", "income").neq("status", "void")
        .gte("occurred_on", desde).lte("occurred_on", hasta)
        .order("occurred_on").limit(1000)
    : { data: [] };
  const sinLiquidar = ((movsVentana ?? []) as unknown as MovimientoBase[])
    .filter((m) => periodoDeMovimiento(m) === periodo)
    .filter((m) => {
      const d = decidido.get(m.id);
      if (!d || d.destino === "caja") return !m.meta?.doctora;
      return d.destino === "casa";
    });
  // Lo que entró en dólares se cuenta pesificado al blue de su fecha: dejarlo
  // afuera del total (como antes) hacía que "sin liquidar" mostrara menos plata
  // de la que realmente está sin asignar.
  const { data: cotiz } = await supabase
    .from("fx_rates").select("quote_date, buy, sell").eq("source", FUENTE_TC);
  const tc = tablaTC(((cotiz ?? []) as Array<{ quote_date: string; buy: string; sell: string }>)
    .map((c): Cotizacion => ({ fecha: c.quote_date, compra: Number(c.buy), venta: Number(c.sell) })));
  const totalSinLiquidar = sinLiquidar.reduce(
    (a, m) => a + Number(m.amount) * (m.currency === "USD" ? tc(m.occurred_on) ?? 0 : 1), 0
  );

  // Claudia no liquida 40%: cobra $100.000 por tratamiento nuevo, pero se paga
  // en la misma tanda mensual — por eso aparece acá además de en Sueldos
  const claudiaMes = ctx.config.slug === "ar" && periodo
    ? (await comisionClaudiaPorMes(supabase, ctx.companyId)).get(periodo) ?? null
    : null;

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Liquidaciones de profesionales</h1>
        <p className="text-sm text-muted-foreground">
          40% de lo cobrado, neto del costo KS del tratamiento. Al confirmar, la
          liquidación pasa a “Por pagar” y el retiro se registra desde ahí.
        </p>
      </div>

      {sinCostear.length ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {sinCostear.length} cobro{sinCostear.length === 1 ? "" : "s"} sin costo KS
            {totalSinCostear > 0 ? ` · ${formatMoney(totalSinCostear, "ARS", locale)} en liquidaciones tuyas` : ""}
          </p>
          <p className="mt-0.5 text-[13px] text-amber-800 dark:text-amber-300/90">
            No se les pudo poner precio, así que entraron con costo $0 y a la
            doctora se le liquida el 40% del <strong>bruto</strong> en vez del neto.
            Se arregla cargando el precio pactado en la ficha del paciente —el link de
            cada nombre— y así queda bien también para las cuotas que vengan. Si el caso
            no tiene pacto posible, el costo se pone a mano en la línea con “Editar a mano”.
          </p>
          <table className="mt-3 w-full text-[13px]">
            <tbody>
              {sinCostear.map((i, n) => (
                <tr key={n} className="border-t border-amber-200/70 dark:border-amber-900/60">
                  <td className="py-1 pr-2 text-amber-700 dark:text-amber-400/80">{i.period ?? "—"}</td>
                  <td className="py-1 pr-2 text-amber-900 dark:text-amber-200">
                    <a
                      href={`/${empresa}/pacientes?q=${encodeURIComponent(i.detail.split(":")[0])}`}
                      className="underline decoration-amber-400 underline-offset-2 hover:decoration-current"
                      title="Abrir la ficha del paciente para cargarle el pacto"
                    >
                      {i.detail.split(":")[0]}
                    </a>
                  </td>
                  <td className="py-1 pr-2 text-amber-700 dark:text-amber-400/80">
                    {i.professional === "Coni"
                      ? "Coni — cuenta propia, no te cuesta"
                      : i.professional ?? "sin doctora"}
                  </td>
                  <td className="fig py-1 text-right font-medium text-amber-900 dark:text-amber-200">
                    {i.amount ? formatMoney(Number(i.amount), i.currency ?? "ARS", locale) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {errorOverrides ? (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          No se pudieron leer los números puestos a mano ({errorOverrides.message}). Las líneas
          corregidas se están mostrando como las calcula el sistema:{" "}
          <strong>no confirmes ninguna liquidación hasta que esto se arregle</strong>.
        </div>
      ) : null}

      {otrosIssues.map((i, n) => (
        <div key={n} className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {i.detail}
        </div>
      ))}

      {periodos.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
          Todavía no hay liquidaciones calculadas.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
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
            {periodo ? (
              <div className="ml-auto flex items-center gap-1.5">
                <a
                  href={`/${empresa}/liquidaciones?p=${periodo}${editar ? "" : "&editar=1"}`}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    editar
                      ? "border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                  title="Corregir a mano los números de una línea, o agregar una que la caja no tiene"
                >
                  {editar ? "Salir del modo edición" : "Editar a mano"}
                </a>
                <RecalcularBoton empresa={ctx.config.slug} periodo={periodo} />
              </div>
            ) : null}
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
                {delPeriodo.flatMap((f) => {
                  const t = (f.totals as Totales) ?? {};
                  const ars = t.ARS ?? {};
                  const nombre = (f.professional as unknown as { display_name?: string } | null)?.display_name ?? "—";
                  const est = ESTADO[f.status] ?? ESTADO.draft;
                  const congelada = f.status === "confirmed" || f.status === "paid";
                  return [
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
                        {editar && !congelada ? (
                          <span className="mr-2 inline-block align-middle">
                            <AgregarLinea
                              empresa={ctx.config.slug}
                              profesionalId={f.professional_id as string}
                              doctora={nombre}
                              periodo={f.period}
                              cuentas={cuentas}
                              hoy={todayIn(ctx.config.timezone)}
                            />
                          </span>
                        ) : null}
                        <a
                          href={`/imprimir/${empresa}/liquidacion/${f.id}`}
                          target="_blank"
                          rel="noopener"
                          className="mr-2 inline-block rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          title={`Exportar la liquidación de ${nombre} en PDF`}
                        >
                          PDF
                        </a>
                        {f.status === "confirmed" ? (
                          <ReabrirLiquidacion
                            empresa={ctx.config.slug}
                            settlementId={f.id}
                            profesional={nombre}
                            periodo={f.period}
                          />
                        ) : null}
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
                    </tr>,
                    // También con CERO líneas cuando hay plata cobrada: son las
                    // liquidaciones viejas que quedaron sin detalle (siete al
                    // 2/9/26, todas pagadas). Justamente ésas son las que el
                    // aviso de descuadre tiene que denunciar, y eran las únicas
                    // que quedaban mudas.
                    (itemsPorSet.get(f.id) ?? []).length > 0 || Number(ars.collected ?? 0) > 0 ? (
                      <tr key={`${f.id}-detalle`} className="border-b last:border-0">
                        <td colSpan={9} className="bg-muted/20 px-4 py-0">
                          <details className="group py-2">
                            <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
                              {(itemsPorSet.get(f.id) ?? []).length === 0
                                ? `Sin detalle: esta liquidación no tiene ninguna línea guardada`
                                : `Ver las ${(itemsPorSet.get(f.id) ?? []).length} líneas de ${nombre.split(" ")[0]}`}
                              {(() => {
                                const its = itemsPorSet.get(f.id) ?? [];
                                const revisadas = its.filter((x) => decidido.get(x.movement_id)?.revisado).length;
                                return revisadas ? (
                                  <span className="ml-1.5 font-normal">
                                    · {revisadas} de {its.length} revisadas
                                  </span>
                                ) : null;
                              })()}
                              <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
                            </summary>
                            <table className="mt-2 w-full text-[12px]">
                              <thead>
                                <tr className="text-left text-[11px] text-muted-foreground">
                                  <th className="w-20 px-2 py-1 font-medium">Fecha</th>
                                  <th className="px-2 py-1 font-medium">Paciente</th>
                                  <th className="px-2 py-1 font-medium">Concepto</th>
                                  <th className="px-2 py-1 text-right font-medium">Cobrado</th>
                                  <th className="px-2 py-1 text-right font-medium">Costo KS</th>
                                  <th className="px-2 py-1 text-right font-medium">Neto</th>
                                  <th className="px-2 py-1 font-medium">Se le liquida a</th>
                                  <th className="w-14 px-2 py-1 text-center font-medium" title="Ya la miré y está bien">Revisada</th>
                                  {editar && !congelada ? (
                                    <th className="w-10 px-2 py-1 text-center font-medium" title="Poner los números de esta línea a mano">A mano</th>
                                  ) : null}
                                </tr>
                              </thead>
                              <tbody>
                                {(itemsPorSet.get(f.id) ?? []).map((it) => {
                                  const pac = (it.movement?.counterparty as { display_name?: string } | null)?.display_name ?? "—";
                                  const yaRevisada = decidido.get(it.movement_id)?.revisado ?? false;
                                  return (
                                    // por movimiento y no por índice: si una
                                    // línea se reimputa, la lista se corre un
                                    // lugar y React reusaría el diálogo de
                                    // edición —con sus números adentro— sobre
                                    // otro paciente.
                                    <tr key={it.movement_id} className="border-t border-border/50">
                                      <td className="fig px-2 py-1 text-muted-foreground">
                                        {dm(it.movement?.occurred_on)}
                                      </td>
                                      <td className="max-w-[180px] truncate px-2 py-1 font-medium">{pac}</td>
                                      <td className="max-w-[260px] truncate px-2 py-1 text-muted-foreground">{it.label ?? "—"}</td>
                                      <td className="fig px-2 py-1 text-right">{formatMoney(Number(it.base_amount), it.currency, locale)}</td>
                                      <td className="fig px-2 py-1 text-right text-muted-foreground">
                                        {Number(it.ks_cost) ? `−${formatMoney(Number(it.ks_cost), it.currency, locale)}` : "—"}
                                      </td>
                                      <td className="fig px-2 py-1 text-right">
                                        {formatMoney(Number(it.base_amount) - Number(it.ks_cost), it.currency, locale)}
                                      </td>
                                      <td className="px-2 py-1">
                                        {congelada ? (
                                          <span className="text-[11px] text-muted-foreground">liquidación cerrada</span>
                                        ) : (
                                          <ImputarCobro
                                            empresa={ctx.config.slug}
                                            movementId={it.movement_id}
                                            valor={valorSelector(it.movement_id)}
                                            doctoraCaja={nombre}
                                            doctoras={doctoras}
                                            paciente={pac}
                                            monto={Number(it.base_amount)}
                                            moneda={it.currency}
                                            locale={locale}
                                          />
                                        )}
                                      </td>
                                      <td className="px-2 py-1 text-center">
                                        {congelada ? (
                                          <span className="text-muted-foreground">—</span>
                                        ) : (
                                          <RevisadoCheck
                                            empresa={ctx.config.slug}
                                            movementId={it.movement_id}
                                            revisado={yaRevisada}
                                            paciente={pac}
                                          />
                                        )}
                                      </td>
                                      {editar && !congelada ? (
                                        <td className="px-2 py-1 text-center">
                                          {(() => {
                                            const ov = overrides.get(it.movement_id) ?? null;
                                            // Con override, base_amount YA es el
                                            // número puesto a mano: lo que el
                                            // motor calculaba está en el snapshot.
                                            return (
                                              <EditarLinea
                                                key={it.movement_id}
                                                empresa={ctx.config.slug}
                                                movementId={it.movement_id}
                                                paciente={pac}
                                                cobradoCalculado={ov?.snapshot.cobrado_calculado ?? Number(it.base_amount)}
                                                costoCalculado={ov?.snapshot.costo_calculado ?? Number(it.ks_cost)}
                                                montoCaja={Number(it.movement?.amount ?? it.base_amount)}
                                                moneda={it.movement?.currency ?? it.currency}
                                                locale={locale}
                                                override={ov}
                                              />
                                            );
                                          })()}
                                        </td>
                                      ) : null}
                                    </tr>
                                  );
                                })}
                              </tbody>
                              {(() => {
                                // El detalle nunca se sumaba contra el total de
                                // arriba: si los dos no dan lo mismo, la doctora
                                // recibe un PDF cuyas líneas no cierran con su
                                // propio total. Ya pasa hoy con las
                                // liquidaciones viejas que quedaron sin detalle.
                                const its = itemsPorSet.get(f.id) ?? [];
                                const subCob = its.reduce((a, x) => a + Number(x.base_amount), 0);
                                const subKs = its.reduce((a, x) => a + Number(x.ks_cost), 0);
                                const dif = subCob - Number(ars.collected ?? 0);
                                return (
                                  <tfoot>
                                    <tr className="border-t font-medium">
                                      <td className="px-2 py-1" colSpan={3}>
                                        Subtotal de las {its.length} líneas
                                      </td>
                                      <td className="fig px-2 py-1 text-right">{formatMoney(subCob, "ARS", locale)}</td>
                                      <td className="fig px-2 py-1 text-right text-muted-foreground">
                                        {subKs ? `−${formatMoney(subKs, "ARS", locale)}` : "—"}
                                      </td>
                                      <td className="fig px-2 py-1 text-right">{formatMoney(subCob - subKs, "ARS", locale)}</td>
                                      <td colSpan={editar && !congelada ? 3 : 2} />
                                    </tr>
                                    {Math.abs(dif) >= 1 ? (
                                      <tr>
                                        <td colSpan={editar && !congelada ? 9 : 8}
                                          className="px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                                          ⚠ El total de arriba dice {formatMoney(ars.collected ?? 0, "ARS", locale)}:
                                          {dif < 0
                                            ? ` faltan ${formatMoney(-dif, "ARS", locale)} de detalle`
                                            : ` el detalle tiene ${formatMoney(dif, "ARS", locale)} de más`}.
                                        </td>
                                      </tr>
                                    ) : null}
                                  </tfoot>
                                );
                              })()}
                            </table>
                          </details>
                        </td>
                      </tr>
                    ) : null,
                  ];
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

          {cambiosAMano.length ? (
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">Puesto a mano — {periodo}</span>
                <span className="text-xs text-muted-foreground">
                  {cambiosAMano.length} línea{cambiosAMano.length === 1 ? "" : "s"} con números escritos por vos
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                El cálculo respeta estos números en cada recálculo.{" "}
                {editar
                  ? "“Deshacer” los saca y la línea vuelve a valer lo que calcula el sistema — no borra nada: queda anotado quién lo puso, cuándo y por qué."
                  : "Para sacarlos, entrá en “Editar a mano”."}
              </p>
              <table className="mt-3 w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] text-muted-foreground">
                    <th className="w-16 px-2 py-1 font-medium">Fecha</th>
                    <th className="px-2 py-1 font-medium">Paciente</th>
                    <th className="px-2 py-1 font-medium">Qué se puso a mano</th>
                    <th className="px-2 py-1 font-medium">Por qué</th>
                    {editar ? <th className="w-20 px-2 py-1" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {cambiosAMano.map((o) => {
                    const pac = o.snapshot.paciente ?? "—";
                    const de = (v?: number | null) =>
                      v == null ? "lo calculado" : formatMoney(v, "ARS", locale);
                    const cambios = [
                      o.cobradoArs != null
                        ? `cobrado: ${de(o.snapshot.cobrado_calculado)} → ${formatMoney(o.cobradoArs, "ARS", locale)}`
                        : null,
                      o.costoKsArs != null
                        ? `costo KS: ${de(o.snapshot.costo_calculado)} → ${formatMoney(o.costoKsArs, "ARS", locale)}`
                        : null,
                    ].filter(Boolean);
                    return (
                      <tr key={o.movementId} className="border-t border-border/50">
                        <td className="fig px-2 py-1 text-muted-foreground">{dm(o.snapshot.fecha)}</td>
                        <td className="max-w-[180px] truncate px-2 py-1 font-medium">{pac}</td>
                        <td className="px-2 py-1">{cambios.join(" · ")}</td>
                        <td className="max-w-[240px] truncate px-2 py-1 text-muted-foreground">{o.motivo}</td>
                        {/* Deshacer mueve plata: vive detrás del modo edición,
                            igual que el lápiz. En modo lectura el panel se ve
                            entero, pero no se toca. */}
                        {editar ? (
                          <td className="px-2 py-1 text-right">
                            <DeshacerLinea
                              empresa={ctx.config.slug}
                              movementId={o.movementId}
                              paciente={pac}
                            />
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">No se liquidan a nadie — {periodo}</span>
              <span className="fig text-sm font-semibold">{formatMoney(totalSinLiquidar, "ARS", locale)}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              La caja anota quién estaba en el consultorio, no quién hizo el
              tratamiento. Cuando la paciente sólo pasa a retirar no hay trabajo
              profesional detrás: ese cobro queda entero para vos. Acá están los
              del mes, y desde el mismo selector se los podés devolver a la
              doctora que corresponda.
            </p>
            {sinLiquidar.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Ninguno: todos los cobros del mes están imputados a una doctora.
              </p>
            ) : (
              <table className="mt-3 w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] text-muted-foreground">
                    <th className="w-16 px-2 py-1 font-medium">Fecha</th>
                    <th className="px-2 py-1 font-medium">Paciente</th>
                    <th className="px-2 py-1 font-medium">Concepto</th>
                    <th className="px-2 py-1 text-right font-medium">Cobrado</th>
                    <th className="px-2 py-1 font-medium">Se le liquida a</th>
                    <th className="w-14 px-2 py-1 text-center font-medium">Revisada</th>
                  </tr>
                </thead>
                <tbody>
                  {sinLiquidar.map((m) => (
                    <tr key={m.id} className="border-t border-border/50">
                      <td className="fig px-2 py-1 text-muted-foreground">{dm(m.occurred_on)}</td>
                      <td className="max-w-[180px] truncate px-2 py-1 font-medium">
                        {m.counterparties?.display_name ?? "—"}
                      </td>
                      <td className="max-w-[300px] truncate px-2 py-1 text-muted-foreground">
                        {m.meta?.motivo || m.meta?.categoria_origen || "—"}
                        {m.meta?.doctora ? (
                          <span className="ml-1 text-[11px]">· la caja decía {m.meta.doctora}</span>
                        ) : null}
                      </td>
                      <td className="fig px-2 py-1 text-right">
                        {formatMoney(Number(m.amount), m.currency, locale)}
                      </td>
                      <td className="px-2 py-1">
                        <ImputarCobro
                          empresa={ctx.config.slug}
                          movementId={m.id}
                          valor={valorSelector(m.id)}
                          doctoraCaja={m.meta?.doctora ?? null}
                          doctoras={doctoras}
                          paciente={m.counterparties?.display_name ?? "—"}
                          monto={Number(m.amount)}
                          moneda={m.currency}
                          locale={locale}
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <RevisadoCheck
                          empresa={ctx.config.slug}
                          movementId={m.id}
                          revisado={decidido.get(m.id)?.revisado ?? false}
                          paciente={m.counterparties?.display_name ?? "—"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {claudiaMes ? (
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-sm font-semibold">Comisión Claudia — {periodo}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {claudiaMes.cantidad} tratamiento{claudiaMes.cantidad === 1 ? "" : "s"} nuevo{claudiaMes.cantidad === 1 ? "" : "s"} × {formatMoney(COMISION_POR_TRATAMIENTO, "ARS", locale)}
                  </span>
                </div>
                <span className="fig text-lg font-semibold text-emerald-700 dark:text-emerald-400">
                  {formatMoney(claudiaMes.comision, "ARS", locale)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{claudiaMes.pacientes.join(" · ")}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Además de su sueldo — el detalle histórico vive en Sueldos.
              </p>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Los saldos negativos son doctoras que ya retiraron más de lo que les
            correspondía ese mes: se compensan con el mes siguiente.
          </p>
        </>
      )}
    </div>
  );
}

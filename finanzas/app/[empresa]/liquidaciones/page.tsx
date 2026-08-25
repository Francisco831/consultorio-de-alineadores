import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { ConfirmarLiquidacion } from "@/components/compromisos/liquidacion-controles";
import { RecalcularBoton } from "@/components/liquidaciones/recalcular-boton";
import { ImputarCobro, DESTINO_CAJA, DESTINO_CASA } from "@/components/liquidaciones/imputar-cobro";
import { RevisadoCheck } from "@/components/liquidaciones/revisado-check";
import { COMISION_POR_TRATAMIENTO } from "@/lib/liquidaciones/comision-claudia";
import { comisionClaudiaPorMes } from "@/lib/liquidaciones/comision-claudia-query";
import { periodoDeMovimiento, type MovimientoBase } from "@/lib/liquidaciones/recalcular";

type Totales = {
  ARS?: { collected?: number; ks_cost?: number; base?: number; due?: number; withdrawn?: number; balance?: number };
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
  searchParams: Promise<{ p?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const { data: todas } = await supabase
    .from("professional_settlements")
    .select("id, period, status, pct, totals, payable_id, professional:counterparties(display_name)")
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
    movement: { occurred_on: string; counterparty: { display_name: string } | null } | null;
  };
  const { data: itemsRaw } = delPeriodo.length
    ? await supabase
        .from("settlement_items")
        .select("settlement_id, movement_id, base_amount, ks_cost, currency, label, movement:movements(occurred_on, counterparty:counterparties(display_name))")
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
  // Coni queda afuera del selector: cobra a cuenta propia, así que imputarle un
  // cobro sería hacerlo desaparecer de todas las liquidaciones sin decirlo.
  const { data: profsRaw } = await supabase
    .from("professionals")
    .select("counterparty_id, active, settles_separately, cp:counterparties!inner(display_name)")
    .eq("company_id", ctx.companyId);
  const doctoras = (profsRaw ?? [])
    .filter((p) => p.active && !p.settles_separately)
    .map((p) => ({ id: p.counterparty_id as string, nombre: (p.cp as unknown as { display_name: string }).display_name }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

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
  const totalSinLiquidar = sinLiquidar
    .filter((m) => m.currency !== "USD")
    .reduce((a, m) => a + Number(m.amount), 0);

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
              <div className="ml-auto">
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
                        <a
                          href={`/imprimir/${empresa}/liquidacion/${f.id}`}
                          target="_blank"
                          rel="noopener"
                          className="mr-2 inline-block rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          title={`Exportar la liquidación de ${nombre} en PDF`}
                        >
                          PDF
                        </a>
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
                    (itemsPorSet.get(f.id) ?? []).length > 0 ? (
                      <tr key={`${f.id}-detalle`} className="border-b last:border-0">
                        <td colSpan={9} className="bg-muted/20 px-4 py-0">
                          <details className="group py-2">
                            <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
                              Ver las {itemsPorSet.get(f.id)!.length} líneas de {nombre.split(" ")[0]}
                              {(() => {
                                const revisadas = itemsPorSet.get(f.id)!.filter((x) => decidido.get(x.movement_id)?.revisado).length;
                                return revisadas ? (
                                  <span className="ml-1.5 font-normal">
                                    · {revisadas} de {itemsPorSet.get(f.id)!.length} revisadas
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
                                </tr>
                              </thead>
                              <tbody>
                                {itemsPorSet.get(f.id)!.map((it, i) => {
                                  const pac = (it.movement?.counterparty as { display_name?: string } | null)?.display_name ?? "—";
                                  const yaRevisada = decidido.get(it.movement_id)?.revisado ?? false;
                                  return (
                                    <tr key={i} className="border-t border-border/50">
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
                                    </tr>
                                  );
                                })}
                              </tbody>
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

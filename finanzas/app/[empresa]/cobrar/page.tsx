import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort, todayIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CobrarBoton, NuevaDeudaClienteDialog } from "@/components/compromisos/cobrar-controles";
import { planesPacientes, motivoCompleto } from "@/lib/liquidaciones/planes-pacientes";

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

  // Planes de pacientes derivados de la caja (solo consultorio AR)
  let planes: ReturnType<typeof planesPacientes> = [];
  if (ctx.config.slug === "ar") {
    const { data: catAlin } = await supabase.from("categories").select("id")
      .eq("company_id", ctx.companyId).eq("name", "Alineadores").maybeSingle();
    if (catAlin) {
      const { data: pagosAlin } = await supabase
        .from("movements")
        .select("occurred_on, amount, currency, description, meta, counterparty:counterparties(display_name), account:accounts!movements_account_company_fk(separate_books)")
        .eq("company_id", ctx.companyId).eq("kind", "income")
        .eq("category_id", catAlin.id).neq("status", "void").limit(2000);
      planes = planesPacientes(
        (pagosAlin ?? [])
          .filter((m) => !(m.account as { separate_books?: boolean } | null)?.separate_books)
          .map((m) => ({
            paciente: (m.counterparty as { display_name?: string } | null)?.display_name ?? "",
            fecha: m.occurred_on,
            ars: m.currency === "USD" ? 0 : Number(m.amount),
            usd: m.currency === "USD" ? Number(m.amount) : 0,
            motivo: motivoCompleto(m.description, m.meta as { obs?: string; medio_raw?: string } | null),
            doctora: (m.meta as { doctora?: string } | null)?.doctora ?? null,
          }))
      );
    }
  }
  const RANGO = { moroso: 0, atrasado: 1, al_dia: 2, completo: 3 } as const;
  const planesConDeuda = planes
    .filter((pl) => pl.pendienteCuotas > 0 && pl.estado !== "completo")
    .sort((a, b) => RANGO[a.estado] - RANGO[b.estado] || b.diasSinPagar - a.diasSinPagar);
  const morosos = planesConDeuda.filter((p) => p.estado === "moroso");
  const totalPendienteEstimado = planesConDeuda.reduce((a, pl) => a + pl.pendienteEstimadoArs, 0);

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

      {planes.length ? (
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Planes de pacientes — pagado y lo que falta
            </h2>
            <span className="flex items-center gap-3">
              {morosos.length ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">
                  {morosos.length} moroso{morosos.length === 1 ? "" : "s"} · {formatMoney(morosos.reduce((a, p) => a + p.pendienteEstimadoArs, 0), "ARS", locale)}
                </span>
              ) : null}
              <span className="fig text-sm font-semibold text-red-600 dark:text-red-400">
                faltan ≈ {formatMoney(totalPendienteEstimado, "ARS", locale)}
              </span>
            </span>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Derivado de la caja (“cuota X de Y”). El pendiente es un estimado con la
            última cuota conocida — las cuotas se ajustan, así que es piso. La barra
            avanza por plata pagada, no por cantidad de cuotas.
          </p>
          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Paciente</th>
                  <th className="hidden px-2 py-2 font-medium md:table-cell">Doctora</th>
                  <th className="px-2 py-2 font-medium">Estado</th>
                  <th className="px-2 py-2 font-medium">Cuotas</th>
                  <th className="px-2 py-2 text-right font-medium">Pagado</th>
                  <th className="hidden px-2 py-2 text-right font-medium sm:table-cell">Última cuota</th>
                  <th className="px-4 py-2 text-right font-medium">Falta (est.)</th>
                </tr>
              </thead>
              <tbody>
                {planesConDeuda.map((pl) => {
                  return (
                    <tr key={pl.paciente + pl.ultimoPago} className="border-b last:border-0">
                      <td className="max-w-[220px] truncate px-4 py-2 font-medium">{pl.paciente}</td>
                      <td className="hidden px-2 py-2 text-muted-foreground md:table-cell">{pl.doctora ?? "—"}</td>
                      <td className="px-2 py-2">
                        <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                          pl.estado === "moroso" ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                            : pl.estado === "atrasado" ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                            : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300")}>
                          {pl.estado === "moroso" ? `moroso · ${pl.diasSinPagar}d`
                            : pl.estado === "atrasado" ? `atrasado · ${pl.diasSinPagar}d`
                            : "al día"}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <span className="fig whitespace-nowrap text-xs">{pl.cuotasPagadas} de {pl.plan}</span>
                          <div
                            className="h-1.5 w-20 overflow-hidden rounded-full bg-secondary"
                            title={`≈${pl.progresoPct}% del plan por plata pagada`}
                          >
                            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(pl.progresoPct, 4)}%` }} />
                          </div>
                        </div>
                      </td>
                      <td className="fig px-2 py-2 text-right text-emerald-700 dark:text-emerald-400">
                        {formatMoney(pl.pagadoArs, "ARS", locale)}
                        {pl.pagadoUsd ? <div className="text-[11px] text-muted-foreground">+ {formatMoney(pl.pagadoUsd, "USD", locale)}</div> : null}
                      </td>
                      <td className="fig hidden px-2 py-2 text-right text-muted-foreground sm:table-cell">
                        {pl.ultimaCuotaArs ? formatMoney(pl.ultimaCuotaArs, "ARS", locale)
                          : pl.ultimaCuotaUsd ? formatMoney(pl.ultimaCuotaUsd, "USD", locale) : "—"}
                      </td>
                      <td className="fig px-4 py-2 text-right font-semibold text-red-600 dark:text-red-400">
                        {pl.pendienteEstimadoUsd > 0
                          ? formatMoney(pl.pendienteEstimadoUsd, "USD", locale)
                          : formatMoney(pl.pendienteEstimadoArs, "ARS", locale)}
                        <span className="ml-1 text-[11px] font-normal text-muted-foreground">({pl.pendienteCuotas} cuota{pl.pendienteCuotas === 1 ? "" : "s"})</span>
                      </td>
                    </tr>
                  );
                })}
                {planesConDeuda.length === 0 ? (
                  <tr><td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Todos los planes conocidos están al día.
                  </td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

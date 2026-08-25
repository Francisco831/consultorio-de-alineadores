import { notFound } from "next/navigation";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { PrintButton } from "@/components/liquidaciones/print-button";

// Vista imprimible de una liquidación, pensada para mandársela a la doctora:
// detalle cobro por cobro con su costo KS y el total a abonar. Sin retiros ni
// saldos internos. Vive fuera del layout de la app (sin sidebar/header) para
// que "Guardar como PDF" dé una hoja limpia.

type Totales = {
  ARS?: { collected?: number; ks_cost?: number; base?: number; due?: number };
  USD?: { collected?: number; due?: number };
};

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function nombrePeriodo(period: string) {
  const [a, m] = period.split("-").map(Number);
  return `${MESES[(m ?? 1) - 1]} ${a}`;
}

export default async function LiquidacionImprimiblePage({
  params,
}: {
  params: Promise<{ empresa: string; id: string }>;
}) {
  const { empresa, id } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const { data: liq } = await supabase
    .from("professional_settlements")
    .select("id, period, status, pct, totals, professional:counterparties(display_name)")
    .eq("company_id", ctx.companyId)
    .eq("id", id)
    .single();
  if (!liq) notFound();

  const { data: items } = await supabase
    .from("settlement_items")
    .select("base_amount, ks_cost, currency, label, movement:movements(occurred_on, counterparty:counterparties(display_name))")
    .eq("settlement_id", liq.id)
    .limit(1000);

  type Item = {
    base_amount: number; ks_cost: number; currency: string; label: string | null;
    movement: { occurred_on: string; counterparty: { display_name: string } | null } | null;
  };
  const lineas = ((items ?? []) as unknown as Item[]).sort((a, b) =>
    (a.movement?.occurred_on ?? "").localeCompare(b.movement?.occurred_on ?? "")
  );

  const t = (liq.totals as Totales) ?? {};
  const ars = t.ARS ?? {};
  const usd = t.USD ?? {};
  const doctora =
    (liq.professional as unknown as { display_name?: string } | null)?.display_name ?? "—";

  return (
    <div className="min-h-screen bg-white text-neutral-900 print:bg-white">
      <div className="mx-auto max-w-[760px] px-8 py-10 print:max-w-none print:px-0 print:py-0">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-neutral-500">
              Consultorio Palermo
            </p>
            <h1 className="mt-1 text-xl font-semibold">
              Liquidación de honorarios profesionales
            </h1>
            <p className="mt-1 text-sm text-neutral-600">
              {doctora} · {nombrePeriodo(liq.period)}
            </p>
          </div>
          <PrintButton />
        </div>

        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b-2 border-neutral-800 text-left text-[11px] uppercase tracking-wide text-neutral-500">
              <th className="w-16 py-1.5 pr-2 font-medium">Fecha</th>
              <th className="py-1.5 pr-2 font-medium">Paciente</th>
              <th className="py-1.5 pr-2 font-medium">Concepto</th>
              <th className="py-1.5 pr-2 text-right font-medium">Cobrado</th>
              <th className="py-1.5 pr-2 text-right font-medium">Costo KS</th>
              <th className="py-1.5 text-right font-medium">Neto</th>
            </tr>
          </thead>
          <tbody>
            {lineas.map((it, i) => {
              const pac =
                (it.movement?.counterparty as { display_name?: string } | null)?.display_name ?? "—";
              const f = it.movement?.occurred_on ?? "";
              return (
                <tr key={i} className="border-b border-neutral-200">
                  <td className="py-1.5 pr-2 tabular-nums text-neutral-500">
                    {f ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : "—"}
                  </td>
                  <td className="py-1.5 pr-2 font-medium">{pac}</td>
                  <td className="py-1.5 pr-2 text-neutral-600">{it.label ?? "—"}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {formatMoney(Number(it.base_amount), it.currency, locale)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-neutral-500">
                    {Number(it.ks_cost)
                      ? `−${formatMoney(Number(it.ks_cost), it.currency, locale)}`
                      : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatMoney(Number(it.base_amount) - Number(it.ks_cost), it.currency, locale)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-6 ml-auto w-full max-w-[340px] text-[13px]">
          <div className="flex justify-between border-b border-neutral-200 py-1.5">
            <span className="text-neutral-600">Cobrado en el mes</span>
            <span className="tabular-nums">
              {formatMoney(ars.collected ?? 0, "ARS", locale)}
              {usd.collected ? ` + ${formatMoney(usd.collected, "USD", locale)}` : ""}
            </span>
          </div>
          <div className="flex justify-between border-b border-neutral-200 py-1.5">
            <span className="text-neutral-600">Costo KS de tratamientos</span>
            <span className="tabular-nums">−{formatMoney(ars.ks_cost ?? 0, "ARS", locale)}</span>
          </div>
          <div className="flex justify-between border-b border-neutral-200 py-1.5">
            <span className="text-neutral-600">Monto sujeto a liquidación</span>
            <span className="tabular-nums">{formatMoney(ars.base ?? 0, "ARS", locale)}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between border-t-2 border-neutral-800 py-2">
            <span className="font-semibold">A abonar ({Number(liq.pct)}%)</span>
            <span className="text-lg font-semibold tabular-nums">
              {formatMoney(ars.due ?? 0, "ARS", locale)}
              {usd.due ? ` + ${formatMoney(usd.due, "USD", locale)}` : ""}
            </span>
          </div>
        </div>

        <p className="mt-10 text-[11px] text-neutral-400">
          Generado el{" "}
          {new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })}
          {" · "}liquidación {nombrePeriodo(liq.period).toLowerCase()} · {doctora}
        </p>
      </div>
    </div>
  );
}

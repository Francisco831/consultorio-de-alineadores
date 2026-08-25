import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { todayIn } from "@/lib/dates";
import { formatMoney, sumByCurrency } from "@/lib/money";
import { NuevoRetiro } from "@/components/retiros/nuevo-retiro";
import { AnularRetiro } from "@/components/retiros/anular-retiro";
import { TIPO_RETIRO_SOCIO } from "@/lib/retiros";

// Cuánto sacaron los dueños, anotado en el momento. No son los retiros de las
// doctoras (esos son a cuenta de su liquidación y viven en Liquidaciones): esta
// plata sale de la caja y no se le descuenta a nadie.

/** Los que siempre están, aunque todavía no hayan retirado nada este año. */
const FIJOS = ["Pancho", "Gaby y Germán"];

const dm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export default async function RetirosPage({
  params,
}: {
  params: Promise<{ empresa: string }>;
}) {
  const { empresa } = await params;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale, timezone } = ctx.config;
  const hoy = todayIn(timezone);
  const desde = `${hoy.slice(0, 4)}-01-01`;

  const [{ data: cuentas }, { data: movs }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency")
      .eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    // El filtro por tipo lo hace la BASE (contains sobre meta), no un filter en
    // JS sobre las primeras N filas: con un límite y el filtro acá, un año con
    // muchos egresos escondería retiros sin avisar.
    supabase.from("movements")
      .select("id, occurred_on, amount, currency, description, meta, counterparties(display_name)")
      .eq("company_id", ctx.companyId).eq("kind", "expense").neq("status", "void")
      .contains("meta", { tipo_origen: TIPO_RETIRO_SOCIO })
      .gte("occurred_on", desde).order("occurred_on", { ascending: false }).limit(1000),
  ]);

  type Mov = {
    id: string; occurred_on: string; amount: string; currency: string;
    description: string | null; meta: { tipo_origen?: string; quien?: string } | null;
    counterparties: { display_name: string } | null;
  };
  const retiros = ((movs ?? []) as unknown as Mov[]).map((m) => ({
    ...m,
    quien: m.meta?.quien ?? m.counterparties?.display_name ?? "—",
  }));

  // Total por persona y por moneda: las monedas no se suman entre sí.
  const porQuien = new Map<string, Array<{ amount: number; currency: string }>>();
  for (const r of retiros) {
    if (!porQuien.has(r.quien)) porQuien.set(r.quien, []);
    porQuien.get(r.quien)!.push({ amount: Number(r.amount), currency: r.currency });
  }
  const totales = [...porQuien.entries()]
    .map(([quien, filas]) => ({ quien, total: sumByCurrency(filas), cuantos: filas.length }))
    .sort((a, b) => (b.total.ARS ?? 0) - (a.total.ARS ?? 0));

  const habituales = [...new Set([...FIJOS, ...porQuien.keys()])];
  const delMes = retiros.filter((r) => r.occurred_on.slice(0, 7) === hoy.slice(0, 7));
  const totalMes = sumByCurrency(delMes.map((r) => ({ amount: Number(r.amount), currency: r.currency })));

  return (
    <div className="mx-auto max-w-[900px] space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Retiros</h1>
        <p className="text-sm text-muted-foreground">
          Lo que sacan los dueños de la caja. Los retiros de las doctoras no van
          acá: esos son a cuenta de su liquidación y se registran desde Por pagar.
        </p>
      </div>

      <NuevoRetiro
        empresa={ctx.config.slug}
        cuentas={cuentas ?? []}
        habituales={habituales}
        hoy={hoy}
        locale={locale}
      />

      {retiros.length ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                En {MESES[Number(hoy.slice(5, 7)) - 1]}
              </p>
              <p className="fig mt-1 text-lg font-semibold">
                {Object.keys(totalMes).length
                  ? Object.entries(totalMes).map(([m, v]) => formatMoney(v, m, locale)).join(" + ")
                  : "—"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {delMes.length} retiro{delMes.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                En {hoy.slice(0, 4)}, por quién
              </p>
              <div className="mt-1.5 space-y-1">
                {totales.map((t) => (
                  <div key={t.quien} className="flex items-baseline justify-between gap-3 text-sm">
                    <span>{t.quien}</span>
                    <span className="fig font-medium">
                      {Object.entries(t.total).map(([m, v]) => formatMoney(v, m, locale)).join(" + ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-16 px-4 py-2 font-medium">Fecha</th>
                  <th className="px-2 py-2 font-medium">Quién</th>
                  <th className="px-2 py-2 font-medium">Nota</th>
                  <th className="px-2 py-2 text-right font-medium">Monto</th>
                  <th className="w-10 px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {retiros.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="fig px-4 py-2 text-muted-foreground">{dm(r.occurred_on)}</td>
                    <td className="px-2 py-2 font-medium">{r.quien}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {r.description?.replace(`Retiro ${r.quien}`, "").replace(/^ · /, "") || "—"}
                    </td>
                    <td className="fig px-2 py-2 text-right">
                      {formatMoney(Number(r.amount), r.currency, locale)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <AnularRetiro empresa={ctx.config.slug} movementId={r.id} quien={r.quien} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Todavía no hay retiros anotados en {hoy.slice(0, 4)}.
        </p>
      )}
    </div>
  );
}

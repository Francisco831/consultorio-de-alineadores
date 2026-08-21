// Casos MX por doctor: monto pactado (VALOR de la planilla de Juan) y cuánto
// va pagado, con la barra llenándose a medida que entran los pagos. El pagado
// sale de la MISMA planilla (slots de pago), refrescado por el sync diario.
import { redirect } from "next/navigation";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

type Plan = {
  id: string; total_amount: string | null; started_on: string | null; notes: string | null;
  ks_price_key: {
    fila?: number; case?: string; etapa?: string | null; tipo?: string | null;
    categoria?: string | null; paciente?: string | null; pagado?: number;
  } | null;
  doctor: { display_name: string } | null;
};

export default async function CasosPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ q?: string; f?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  if (ctx.config.slug !== "mx") redirect(`/${empresa}/pacientes`);
  const supabase = await createClient();
  const { locale } = ctx.config;
  const f = sp.f ?? "saldo";

  const { data, error } = await supabase
    .from("treatment_plans")
    .select("id, total_amount, started_on, notes, ks_price_key, doctor:counterparties!treatment_plans_patient_id_company_id_fkey(display_name)")
    .eq("company_id", ctx.companyId)
    .neq("status", "cancelled")
    .limit(3000);
  if (error) throw new Error(`Error consultando casos: ${error.message}`);

  type Caso = {
    id: string; doctor: string; caso: string; paciente: string; etapa: string;
    fecha: string | null; valor: number; pagado: number; saldo: number;
  };
  let casos: Caso[] = ((data ?? []) as unknown as Plan[]).map((p) => {
    const k = p.ks_price_key ?? {};
    const valor = Number(p.total_amount ?? 0);
    const pagado = Number(k.pagado ?? 0);
    return {
      id: p.id,
      doctor: p.doctor?.display_name ?? "(sin doctor)",
      caso: k.case ?? "—",
      paciente: k.paciente ?? "—",
      etapa: [k.tipo, k.etapa].filter(Boolean).join(" · "),
      fecha: p.started_on,
      valor, pagado: Math.min(pagado, valor > 0 ? Math.max(pagado, valor) : pagado),
      saldo: Math.max(0, valor - pagado),
    };
  });

  if (sp.q) {
    const nq = sp.q.trim().toLowerCase();
    casos = casos.filter((c) =>
      c.doctor.toLowerCase().includes(nq) || c.paciente.toLowerCase().includes(nq) || c.caso.toLowerCase().includes(nq));
  }
  if (f === "saldo") casos = casos.filter((c) => c.valor > 0 && c.saldo > 1);
  else if (f === "2026") casos = casos.filter((c) => (c.fecha ?? "") >= "2026-01-01");

  // agrupar por doctor, deudores primero
  const porDoctor = new Map<string, Caso[]>();
  for (const c of casos) {
    if (!porDoctor.has(c.doctor)) porDoctor.set(c.doctor, []);
    porDoctor.get(c.doctor)!.push(c);
  }
  const doctores = [...porDoctor.entries()]
    .map(([doctor, cs]) => ({
      doctor, casos: cs.sort((a, b) => (b.fecha ?? "").localeCompare(a.fecha ?? "")),
      saldo: cs.reduce((a, c) => a + c.saldo, 0),
      valor: cs.reduce((a, c) => a + c.valor, 0),
    }))
    .sort((a, b) => b.saldo - a.saldo || a.doctor.localeCompare(b.doctor));
  const saldoTotal = doctores.reduce((a, d) => a + d.saldo, 0);

  const FILTROS = [
    { key: "saldo", label: "Con saldo" },
    { key: "2026", label: "Casos 2026" },
    { key: "todos", label: "Todos" },
  ];

  return (
    <div className="mx-auto max-w-[1200px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Casos por doctor</h1>
          <p className="text-sm text-muted-foreground">
            {f === "saldo" ? (
              <>Deuda viva: <span className="fig font-semibold text-red-600 dark:text-red-400">{formatMoney(saldoTotal, "MXN", locale)}</span> en {casos.length} casos.</>
            ) : (
              <>{casos.length.toLocaleString(locale)} casos · saldo {formatMoney(saldoTotal, "MXN", locale)}</>
            )}
          </p>
        </div>
        <form action={`/${empresa}/casos`} className="flex items-center gap-2">
          {sp.f ? <input type="hidden" name="f" value={sp.f} /> : null}
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Doctor, paciente o caso…" className="h-8 w-64" />
        </form>
      </div>

      <div className="flex gap-1.5">
        {FILTROS.map((fl) => (
          <a
            key={fl.key}
            href={`/${empresa}/casos?f=${fl.key}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}`}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              f === fl.key ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-accent"
            )}
          >
            {fl.label}
          </a>
        ))}
      </div>

      <div className="space-y-4">
        {doctores.slice(0, 60).map((d) => (
          <section key={d.doctor} className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-baseline justify-between border-b bg-muted/40 px-4 py-2">
              <h2 className="text-sm font-semibold">{d.doctor}</h2>
              <span className="fig text-xs text-muted-foreground">
                {d.casos.length} caso{d.casos.length === 1 ? "" : "s"}
                {d.saldo > 1 ? (
                  <> · debe <span className="font-semibold text-red-600 dark:text-red-400">{formatMoney(d.saldo, "MXN", locale)}</span></>
                ) : null}
              </span>
            </div>
            <table className="w-full text-[13px]">
              <tbody>
                {d.casos.map((c) => {
                  const pct = c.valor > 0 ? Math.min(100, Math.round((c.pagado / c.valor) * 100)) : 0;
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="fig w-20 px-4 py-2 font-medium">{c.caso}</td>
                      <td className="max-w-[200px] truncate px-2 py-2">{c.paciente}</td>
                      <td className="hidden max-w-[160px] truncate px-2 py-2 text-xs text-muted-foreground md:table-cell">{c.etapa}</td>
                      <td className="fig hidden w-24 px-2 py-2 text-xs text-muted-foreground sm:table-cell">
                        {c.fecha ? formatDateShort(c.fecha, locale) : "—"}
                      </td>
                      <td className="w-[220px] px-2 py-2">
                        {c.valor > 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                              <div
                                className={cn("h-full rounded-full", pct >= 100 ? "bg-emerald-500" : pct > 0 ? "bg-amber-500" : "bg-red-400")}
                                style={{ width: `${Math.max(pct, 4)}%` }}
                              />
                            </div>
                            <span className="fig w-9 text-right text-[11px] text-muted-foreground">{pct}%</span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">sin precio cargado</span>
                        )}
                      </td>
                      <td className="fig w-40 px-4 py-2 text-right">
                        <span className={cn(c.saldo > 1 ? "font-semibold" : "text-muted-foreground")}>
                          {formatMoney(c.pagado, "MXN", locale)}
                          <span className="text-muted-foreground"> / {formatMoney(c.valor, "MXN", locale)}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}
        {doctores.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
            Nada con estos filtros.
          </div>
        ) : null}
      </div>
      {doctores.length > 60 ? (
        <p className="text-xs text-muted-foreground">Mostrando 60 doctores — usá el buscador para el resto.</p>
      ) : null}
    </div>
  );
}

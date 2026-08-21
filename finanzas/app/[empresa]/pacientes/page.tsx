// Pacientes del consultorio: quién es, con qué doctora se atiende, cuánto
// pagó y cuándo fue la última vez. Todo sale de la caja (movements) — no hay
// carga aparte. Los pagos de la caja Coni no se muestran (contabilidad
// separada); un paciente 100% de Coni directamente no aparece.
import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort } from "@/lib/dates";
import { Input } from "@/components/ui/input";

type Mov = {
  occurred_on: string; amount: string; currency: string; counterparty_id: string;
  meta: { doctora?: string } | null;
  counterparty: { display_name: string } | null;
  category: { name: string } | null;
  account: { separate_books: boolean } | null;
};

type Paciente = {
  id: string; nombre: string; doctora: string | null;
  categorias: Set<string>; pagos: number;
  totales: Map<string, number>; ultimo: string; primero: string;
};

export default async function PacientesPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { empresa } = await params;
  const { q } = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const { data: movs, error } = await supabase
    .from("movements")
    .select(
      "occurred_on, amount, currency, counterparty_id, meta, counterparty:counterparties(display_name, kind), category:categories(name), account:accounts!movements_account_company_fk(separate_books)"
    )
    .eq("company_id", ctx.companyId)
    .eq("kind", "income")
    .neq("status", "void")
    .not("counterparty_id", "is", null)
    .limit(5000);
  if (error) throw new Error(`Error consultando pacientes: ${error.message}`);

  const porPaciente = new Map<string, Paciente>();
  for (const m of (movs ?? []) as unknown as (Mov & { counterparty: { kind?: string } | null })[]) {
    if (m.account?.separate_books) continue;                    // caja Coni afuera
    if ((m.counterparty as { kind?: string } | null)?.kind !== "patient") continue;
    const p = porPaciente.get(m.counterparty_id) ?? {
      id: m.counterparty_id,
      nombre: (m.counterparty as { display_name?: string } | null)?.display_name ?? "(sin nombre)",
      doctora: null, categorias: new Set<string>(), pagos: 0,
      totales: new Map<string, number>(), ultimo: m.occurred_on, primero: m.occurred_on,
    };
    p.pagos += 1;
    p.totales.set(m.currency, (p.totales.get(m.currency) ?? 0) + Number(m.amount));
    if (m.category?.name) p.categorias.add(m.category.name);
    if (m.meta?.doctora) p.doctora = m.meta.doctora;
    if (m.occurred_on > p.ultimo) p.ultimo = m.occurred_on;
    if (m.occurred_on < p.primero) p.primero = m.occurred_on;
    porPaciente.set(m.counterparty_id, p);
  }

  let pacientes = [...porPaciente.values()].sort((a, b) => b.ultimo.localeCompare(a.ultimo));
  if (q) {
    const nq = q.trim().toLowerCase();
    pacientes = pacientes.filter((p) => p.nombre.toLowerCase().includes(nq) || (p.doctora ?? "").toLowerCase().includes(nq));
  }
  const visibles = pacientes.slice(0, 250);

  return (
    <div className="mx-auto max-w-[1200px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Pacientes</h1>
          <p className="text-sm text-muted-foreground">
            {pacientes.length.toLocaleString(locale)} pacientes con pagos en la caja.
          </p>
        </div>
        <form action={`/${empresa}/pacientes`}>
          <Input name="q" defaultValue={q ?? ""} placeholder="Buscar paciente o doctora…" className="h-8 w-64" />
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Paciente</th>
              <th className="hidden px-2 py-2 font-medium md:table-cell">Doctora</th>
              <th className="hidden px-2 py-2 font-medium lg:table-cell">Tratamiento</th>
              <th className="px-2 py-2 text-center font-medium">Pagos</th>
              <th className="px-2 py-2 text-right font-medium">Total pagado</th>
              <th className="px-4 py-2 text-right font-medium">Último pago</th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 ? (
              <tr><td colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                {q ? "Ningún paciente con esa búsqueda." : "Todavía no hay pagos de pacientes en la caja."}
              </td></tr>
            ) : visibles.map((p) => (
              <tr key={p.id} className="border-b last:border-0 hover:bg-accent/40">
                <td className="max-w-[240px] truncate px-4 py-2 font-medium">
                  <Link href={`/${empresa}/movimientos?cp=${p.id}`} className="hover:underline">{p.nombre}</Link>
                </td>
                <td className="hidden px-2 py-2 text-muted-foreground md:table-cell">{p.doctora ?? "—"}</td>
                <td className="hidden px-2 py-2 lg:table-cell">
                  {[...p.categorias].map((c) => (
                    <span key={c} className="mr-1 rounded-full bg-secondary px-2 py-0.5 text-[11px]">{c}</span>
                  ))}
                </td>
                <td className="fig px-2 py-2 text-center text-muted-foreground">{p.pagos}</td>
                <td className="fig px-2 py-2 text-right font-medium text-emerald-700 dark:text-emerald-400">
                  {[...p.totales].map(([cur, tot]) => formatMoney(tot, cur, locale)).join(" + ")}
                </td>
                <td className="fig px-4 py-2 text-right text-muted-foreground">{formatDateShort(p.ultimo, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pacientes.length > visibles.length ? (
        <p className="text-xs text-muted-foreground">
          Mostrando los {visibles.length} con pagos más recientes — usá el buscador para el resto.
        </p>
      ) : null}
    </div>
  );
}

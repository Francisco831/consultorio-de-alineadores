import Link from "next/link";
import { requireEmpresa } from "@/lib/empresa-context";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/money";
import { formatDateShort, todayIn, monthStartIn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RowActions } from "@/components/movimientos/row-actions";

const PAGE_SIZE = 50;

// clave-de-URL → columna real (evita inyección de nombres de columna)
const SORTS: Record<string, { col: string; label: string }> = {
  fecha: { col: "occurred_on", label: "Fecha" },
  monto: { col: "amount", label: "Monto" },
  concepto: { col: "description", label: "Concepto" },
  estado: { col: "status", label: "Estado" },
};

const FILTROS: Array<{ key: string; label: string }> = [
  { key: "todos", label: "Todos" },
  { key: "ingresos", label: "Ingresos" },
  { key: "gastos", label: "Gastos" },
  { key: "transferencias", label: "Transferencias" },
  { key: "pendientes", label: "Pendientes" },
];

const ESTADO_CHIP: Record<string, string> = {
  confirmed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  void: "bg-muted text-muted-foreground line-through",
};
const ESTADO_LABEL: Record<string, string> = {
  confirmed: "Confirmado", pending: "Pendiente", void: "Anulado",
};

export default async function MovimientosPage({
  params, searchParams,
}: {
  params: Promise<{ empresa: string }>;
  searchParams: Promise<{ q?: string; f?: string; cuenta?: string; cp?: string; cat?: string; estado?: string; p?: string; sort?: string; dir?: string; desde?: string; hasta?: string }>;
}) {
  const { empresa } = await params;
  const sp = await searchParams;
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { locale } = ctx.config;

  const f = sp.f ?? "todos";
  const page = Math.max(1, Number(sp.p) || 1);
  const sortKey = SORTS[sp.sort ?? ""] ? sp.sort! : "fecha";
  const dir = sp.dir === "asc" ? "asc" : "desc";
  const esFecha = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const desde = esFecha(sp.desde);
  const hasta = esFecha(sp.hasta);

  // contabilidades separadas (caja Coni): fuera del listado salvo su propia pestaña
  const { data: cuentasTodas } = await supabase
    .from("accounts").select("id, name, separate_books, ks_custody")
    .eq("company_id", ctx.companyId).order("name");
  const idsSep = (cuentasTodas ?? []).filter((a) => a.separate_books).map((a) => a.id);
  const custodiaKs = new Set((cuentasTodas ?? []).filter((a) => a.ks_custody).map((a) => a.id));
  const { data: categorias } = await supabase
    .from("categories").select("id, name")
    .eq("company_id", ctx.companyId).eq("is_active", true).order("name");

  let query = supabase
    .from("movements")
    .select(
      // movements tiene DOS FKs hacia accounts: sin el hint del constraint el
      // embed es ambiguo (PGRST201) y PostgREST devuelve data=null en silencio
      "id, occurred_on, kind, status, amount, currency, description, source, transfer_group_id, account_id, counterparty:counterparties(display_name), category:categories(name), account:accounts!movements_account_company_fk(name)",
      { count: "exact" }
    )
    .eq("company_id", ctx.companyId);

  if (f === "coni") query = query.neq("status", "void");
  else if (f === "ingresos") query = query.eq("kind", "income").neq("status", "void");
  else if (f === "gastos") query = query.eq("kind", "expense").neq("status", "void");
  else if (f === "transferencias") query = query.in("kind", ["transfer_in", "transfer_out"]).neq("status", "void");
  else if (f === "pendientes") query = query.eq("status", "pending");
  else query = query.neq("status", "void");

  if (f === "coni") {
    query = idsSep.length ? query.in("account_id", idsSep) : query.eq("account_id", "00000000-0000-0000-0000-000000000000");
  } else if (idsSep.length && !sp.cuenta) {
    query = query.not("account_id", "in", `(${idsSep.join(",")})`);
  }
  if (sp.cuenta) query = query.eq("account_id", sp.cuenta);
  if (sp.cp) query = query.eq("counterparty_id", sp.cp);
  if (sp.cat) query = query.eq("category_id", sp.cat);
  if (sp.estado && ["confirmed", "pending", "void"].includes(sp.estado)) query = query.eq("status", sp.estado);
  if (sp.q) query = query.ilike("description", `%${sp.q}%`);
  if (desde) query = query.gte("occurred_on", desde);
  if (hasta) query = query.lte("occurred_on", hasta);

  const from = (page - 1) * PAGE_SIZE;
  const { data: movimientos, count, error } = await query
    .order(SORTS[sortKey].col, { ascending: dir === "asc" })
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (error) {
    // un error de query NO puede renderizar como "0 movimientos"
    throw new Error(`Error consultando movimientos: ${error.message}`);
  }

  // comprobantes adjuntos (Drive) de los movimientos visibles
  const idsPagina = (movimientos ?? []).map((m) => m.id);
  const { data: docs } = idsPagina.length
    ? await supabase
        .from("documents")
        .select("entity_id, storage_path, filename")
        .eq("company_id", ctx.companyId)
        .eq("entity_type", "movement")
        .in("entity_id", idsPagina)
    : { data: [] as { entity_id: string; storage_path: string; filename: string }[] };
  const docsPorMov = new Map<string, { storage_path: string; filename: string }[]>();
  for (const d of docs ?? []) {
    const lista = docsPorMov.get(d.entity_id);
    if (lista) lista.push(d);
    else docsPorMov.set(d.entity_id, [d]);
  }

  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const urlCon = (cambios: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const estado = { q: sp.q, f: sp.f, cuenta: sp.cuenta, cp: sp.cp, cat: sp.cat, estado: sp.estado, sort: sp.sort, dir: sp.dir, desde: sp.desde, hasta: sp.hasta, ...cambios };
    for (const [k, v] of Object.entries(estado)) if (v) p.set(k, v);
    const qs = p.toString();
    return `/${empresa}/movimientos${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Movimientos</h1>
        <form action={`/${empresa}/movimientos`} className="flex items-center gap-2">
          {sp.f ? <input type="hidden" name="f" value={sp.f} /> : null}
          <Input
            name="q" defaultValue={sp.q ?? ""} placeholder="Buscar en conceptos…"
            className="h-8 w-56"
          />
        </form>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTROS.map((fl) => (
          <Link
            key={fl.key}
            href={urlCon({ f: fl.key === "todos" ? undefined : fl.key, p: undefined })}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              f === fl.key
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:bg-accent"
            )}
          >
            {fl.label}
          </Link>
        ))}
        {idsSep.length ? (
          <Link
            href={urlCon({ f: f === "coni" ? undefined : "coni", p: undefined })}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              f === "coni"
                ? "border-violet-600 bg-violet-600 text-white"
                : "border-violet-300 bg-card text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950"
            )}
            title="Contabilidad separada — no suma en los números del consultorio"
          >
            Caja Coni
          </Link>
        ) : null}
        {sp.cp ? (
          <Link
            href={urlCon({ cp: undefined, p: undefined })}
            className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
          >
            Contraparte filtrada ✕
          </Link>
        ) : null}
        {sp.cuenta ? (
          <Link
            href={urlCon({ cuenta: undefined, p: undefined })}
            className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
          >
            Cuenta filtrada ✕
          </Link>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {(() => {
          const tz = ctx.config.timezone;
          const hoy = todayIn(tz);
          const inicioMes = monthStartIn(tz);
          const d = new Date(`${hoy}T12:00:00Z`);
          const hace7 = new Date(d); hace7.setUTCDate(d.getUTCDate() - 6);
          const semana = hace7.toISOString().slice(0, 10);
          const mesPasadoFin = new Date(`${inicioMes}T12:00:00Z`); mesPasadoFin.setUTCDate(0);
          const mesPasadoIni = `${mesPasadoFin.toISOString().slice(0, 7)}-01`;
          const presets = [
            { label: "Hoy", desde: hoy, hasta: hoy },
            { label: "7 días", desde: semana, hasta: hoy },
            { label: "Este mes", desde: inicioMes, hasta: hoy },
            { label: "Mes pasado", desde: mesPasadoIni, hasta: mesPasadoFin.toISOString().slice(0, 10) },
          ];
          return presets.map((pr) => {
            const activo = desde === pr.desde && hasta === pr.hasta;
            return (
              <Link
                key={pr.label}
                href={urlCon({ desde: activo ? undefined : pr.desde, hasta: activo ? undefined : pr.hasta, p: undefined })}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  activo
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:bg-accent"
                )}
              >
                {pr.label}
              </Link>
            );
          });
        })()}
        <form action={`/${empresa}/movimientos`} className="flex flex-wrap items-center gap-1.5">
          {sp.f ? <input type="hidden" name="f" value={sp.f} /> : null}
          {sp.q ? <input type="hidden" name="q" value={sp.q} /> : null}
          <select name="cat" defaultValue={sp.cat ?? ""} className="h-7 max-w-[170px] rounded-md border bg-card px-1.5 text-xs" aria-label="Categoría">
            <option value="">Categoría: todas</option>
            {(categorias ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select name="cuenta" defaultValue={sp.cuenta ?? ""} className="h-7 max-w-[170px] rounded-md border bg-card px-1.5 text-xs" aria-label="Cuenta">
            <option value="">Cuenta: todas</option>
            {(cuentasTodas ?? []).filter((a) => !a.separate_books).map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.ks_custody ? " (KS)" : ""}</option>
            ))}
          </select>
          <select name="estado" defaultValue={sp.estado ?? ""} className="h-7 rounded-md border bg-card px-1.5 text-xs" aria-label="Estado">
            <option value="">Estado: todos</option>
            <option value="confirmed">Confirmado</option>
            <option value="pending">Pendiente</option>
            <option value="void">Anulado</option>
          </select>
          <input type="date" name="desde" defaultValue={desde ?? ""} className="h-7 rounded-md border bg-card px-2 text-xs" aria-label="Desde" />
          <span className="text-xs text-muted-foreground">→</span>
          <input type="date" name="hasta" defaultValue={hasta ?? ""} className="h-7 rounded-md border bg-card px-2 text-xs" aria-label="Hasta" />
          <button type="submit" className="h-7 rounded-md border px-2 text-xs font-medium hover:bg-accent">Filtrar</button>
          {desde || hasta || sp.cat || sp.estado || sp.cuenta ? (
            <Link href={urlCon({ desde: undefined, hasta: undefined, cat: undefined, estado: undefined, cuenta: undefined, p: undefined })} className="text-xs text-muted-foreground hover:text-foreground">
              ✕ limpiar
            </Link>
          ) : null}
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">
                <Link href={urlCon({ sort: "fecha", dir: sortKey === "fecha" && dir === "desc" ? "asc" : "desc" })} className="hover:text-foreground">
                  Fecha {sortKey === "fecha" ? (dir === "desc" ? "↓" : "↑") : ""}
                </Link>
              </TableHead>
              <TableHead>
                <Link href={urlCon({ sort: "concepto", dir: sortKey === "concepto" && dir === "asc" ? "desc" : "asc" })} className="hover:text-foreground">
                  Concepto {sortKey === "concepto" ? (dir === "desc" ? "↓" : "↑") : ""}
                </Link>
              </TableHead>
              <TableHead className="hidden md:table-cell">Contraparte</TableHead>
              <TableHead className="hidden lg:table-cell">Categoría</TableHead>
              <TableHead className="hidden lg:table-cell">Cuenta</TableHead>
              <TableHead className="hidden sm:table-cell">
                <Link href={urlCon({ sort: "estado", dir: sortKey === "estado" && dir === "asc" ? "desc" : "asc" })} className="hover:text-foreground">
                  Estado {sortKey === "estado" ? (dir === "desc" ? "↓" : "↑") : ""}
                </Link>
              </TableHead>
              <TableHead className="text-right">
                <Link href={urlCon({ sort: "monto", dir: sortKey === "monto" && dir === "desc" ? "asc" : "desc" })} className="hover:text-foreground">
                  Monto {sortKey === "monto" ? (dir === "desc" ? "↓" : "↑") : ""}
                </Link>
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(movimientos ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-sm text-muted-foreground">
                  {sp.q || sp.cuenta || f !== "todos"
                    ? "Nada con estos filtros."
                    : "Acá va a vivir cada peso que entra y sale. Cargá el primero con “+ Nuevo” o importá un extracto."}
                </TableCell>
              </TableRow>
            ) : (
              (movimientos ?? []).map((mv) => {
                const esTransfer = mv.kind === "transfer_in" || mv.kind === "transfer_out";
                const negativo = mv.kind === "expense" || mv.kind === "transfer_out";
                const cp = (mv.counterparty as { display_name?: string } | null)?.display_name;
                const cat = (mv.category as { name?: string } | null)?.name;
                const acc = (mv.account as { name?: string } | null)?.name;
                return (
                  <TableRow key={mv.id} className={cn(mv.status === "void" && "opacity-50")}>
                    <TableCell className="fig text-muted-foreground">
                      {formatDateShort(mv.occurred_on, locale)}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate font-medium">
                      {mv.description || (esTransfer ? "Transferencia interna" : "—")}
                      {mv.source !== "manual" ? (
                        <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase text-secondary-foreground">
                          {mv.source === "crm_sync" ? "CRM" : mv.source}
                        </span>
                      ) : null}
                      {(docsPorMov.get(mv.id) ?? [])
                        .filter((d) => !d.storage_path.startsWith("http"))
                        .map((d) => (
                          <span
                            key={d.storage_path}
                            title={`Comprobante: ${d.filename}`}
                            className="ml-1.5 align-middle opacity-70"
                          >
                            📎
                          </span>
                        ))}
                      {(docsPorMov.get(mv.id) ?? [])
                        .filter((d) => d.storage_path.startsWith("http"))
                        .map((d) => (
                          <a
                            key={d.storage_path}
                            href={d.storage_path}
                            target="_blank"
                            rel="noreferrer"
                            title={`Comprobante: ${d.filename}`}
                            className="ml-1.5 align-middle no-underline opacity-70 hover:opacity-100"
                          >
                            📎
                          </a>
                        ))}
                    </TableCell>
                    <TableCell className="hidden max-w-[180px] truncate md:table-cell">{cp ?? "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {cat ? (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{cat}</span>
                      ) : esTransfer ? (
                        <span className="text-xs text-muted-foreground">Transferencia</span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {acc ?? "—"}
                      {custodiaKs.has(mv.account_id) ? (
                        <span
                          title="Cuenta de KeepSmiling: esta plata hay que pedirla"
                          className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                        >
                          en KS
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", ESTADO_CHIP[mv.status])}>
                        {ESTADO_LABEL[mv.status]}
                      </span>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "fig text-right font-medium",
                        mv.status !== "void" && !esTransfer && mv.kind === "expense" && "text-red-600 dark:text-red-400",
                        mv.status !== "void" && !esTransfer && mv.kind === "income" && "text-emerald-600 dark:text-emerald-400",
                        esTransfer && "text-muted-foreground"
                      )}
                    >
                      {negativo ? "−" : mv.kind === "income" ? "+" : ""}{formatMoney(Number(mv.amount), mv.currency, locale)}
                    </TableCell>
                    <TableCell>
                      <RowActions empresa={ctx.config.slug} movementId={mv.id} status={mv.status} source={mv.source} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="fig">{total.toLocaleString(locale)} movimientos</span>
        {pages > 1 ? (
          <div className="flex gap-1">
            {page > 1 ? (
              <Link href={urlCon({ p: String(page - 1) })} className="rounded border px-2 py-1 hover:bg-accent">←</Link>
            ) : null}
            <span className="px-2 py-1">página {page} de {pages}</span>
            {page < pages ? (
              <Link href={urlCon({ p: String(page + 1) })} className="rounded border px-2 py-1 hover:bg-accent">→</Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

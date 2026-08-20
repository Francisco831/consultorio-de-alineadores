import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import {
  ACREDITACION_STYLES,
  CATEGORIA_LABELS,
  CATEGORIA_STYLES,
  LIFECYCLE_STYLES,
  formatDate,
  healthColor,
  relativeDays,
} from "@/lib/format";
import {
  LIFECYCLE_LABELS,
  type Doctor,
  type LifecycleStage,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Search, PhoneOff } from "lucide-react";

const PAGE_SIZE = 50;

// columnas ordenables: clave de URL → columna de la DB
const SORTS: Record<string, { col: string; label: string }> = {
  prioridad: { col: "priority_score", label: "Prioridad" },
  casos: { col: "new_case_count", label: "Casos" },
  ultimo: { col: "last_new_case_at", label: "Último caso" },
  ritmo: { col: "avg_interval_days", label: "Ritmo" },
  health: { col: "health_score", label: "Health" },
};

// ESTA PANTALLA ES EL ÁREA "ACREDITADOS", entera. El corte no es un tab que se pueda
// desmarcar: la consulta de abajo agrega `.eq("is_accredited", true)` siempre. Los
// doctores por acreditarse tienen su propia lista en /prospeccion/lista, con las
// columnas que les corresponden.
//
// Los tabs de acá adentro filtran por lifecycle_stage, y eso NO alcanza por sí solo:
// lifecycle_stage es un enum de 14 etapas que atraviesa las dos áreas, así que
// "Perdidos" sin el corte devolvía prospectos descartados mezclados con acreditados
// que se fueron. Lo mismo "Activos", "En riesgo" y "Dormidos".
// "sigue-instagram" no es una etapa del ciclo de vida sino un hecho del canal:
// lo pone scripts/tag-seguidores-ig.ts desde el censo de seguidores del 20/8.
// Por eso filtra por tag y no por lifecycle_stage.
const TAG_IG = "sigue-instagram";

const FILTERS: {
  key: string;
  label: string;
  stages?: LifecycleStage[];
  tag?: string;
}[] = [
  { key: "todos", label: "Todos" },
  {
    key: "activacion",
    label: "Activación",
    stages: ["acreditado", "en_activacion", "activado"],
  },
  { key: "activos", label: "Activos", stages: ["activo", "growth", "reactivado"] },
  { key: "riesgo", label: "En riesgo", stages: ["en_riesgo"] },
  { key: "dormidos", label: "Dormidos", stages: ["dormido"] },
  { key: "perdidos", label: "Perdidos", stages: ["perdido"] },
  { key: "ig", label: "Te siguen en IG", tag: TAG_IG },
];

function SortableHead({
  k,
  label,
  right,
  q,
  f,
  sort,
  dir,
}: {
  k: string;
  label: string;
  right?: boolean;
  q: string;
  f: string;
  sort: string;
  dir?: string;
}) {
  const active = sort === k;
  // primer click ordena descendente (lo útil: más casos primero); segundo, asc
  const nextDir = active && dir !== "asc" ? "asc" : undefined;
  const params = new URLSearchParams({
    ...(q ? { q } : {}),
    ...(f !== "todos" ? { f } : {}),
    ...(k !== "prioridad" || nextDir ? { sort: k } : {}),
    ...(nextDir ? { dir: nextDir } : {}),
  });
  return (
    <TableHead className={right ? "text-right" : undefined}>
      <Link
        href={`/doctores?${params}`}
        className={cn(
          "inline-flex items-center gap-0.5 hover:text-foreground",
          active && "font-semibold text-foreground"
        )}
      >
        {label}
        {active ? (dir === "asc" ? " ↑" : " ↓") : null}
      </Link>
    </TableHead>
  );
}

export default async function DoctoresPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    f?: string;
    p?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const { q = "", f = "todos", p = "1", sort = "prioridad", dir } = await searchParams;
  const page = Math.max(1, parseInt(p) || 1);
  const supabase = await createClient();

  const sortDef = SORTS[sort] ?? SORTS.prioridad;
  const ascending = dir === "asc";

  let query = supabase
    .from("doctors")
    .select("*", { count: "exact" })
    .order(sortDef.col, { ascending, nullsFirst: false })
    .order("new_case_count", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  // el corte del área, no negociable desde la URL
  query = query.eq("is_accredited", true);

  if (q) query = query.ilike("nombre", `%${q}%`);
  const filter = FILTERS.find((x) => x.key === f);
  if (filter?.stages) query = query.in("lifecycle_stage", filter.stages);
  if (filter?.tag) query = query.contains("tags", [filter.tag]);

  const { data, count, error } = await query;
  const doctors = (data ?? []) as Doctor[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Doctores</h1>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "acreditado" : "acreditados"} ·{" "}
            <Link href="/prospeccion/lista" className="hover:underline">
              ver los que están por acreditarse
            </Link>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form className="relative" action="/doctores">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Buscar doctor…"
            className="h-9 w-64 pl-8"
          />
          {f !== "todos" ? <input type="hidden" name="f" value={f} /> : null}
        </form>
        <div className="flex gap-1">
          {FILTERS.map((x) => (
            <Link
              key={x.key}
              href={`/doctores?${new URLSearchParams({
                ...(q ? { q } : {}),
                ...(x.key !== "todos" ? { f: x.key } : {}),
              })}`}
              className={cn(
                buttonVariants({
                  variant: f === x.key ? "secondary" : "ghost",
                  size: "sm",
                }),
                "h-8 text-[13px]"
              )}
            >
              {x.label}
            </Link>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          Error cargando doctores: {error.message}
        </p>
      ) : doctors.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {q && f !== "todos"
            ? `Ningún doctor de “${FILTERS.find((x) => x.key === f)?.label}” coincide con “${q}”.`
            : q
              ? `No hay doctores que coincidan con “${q}”.`
              : f !== "todos"
                ? `No hay doctores en “${FILTERS.find((x) => x.key === f)?.label}” por ahora.`
                : "Todavía no hay doctores acreditados."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Doctor</TableHead>
                <TableHead>Acreditación</TableHead>
                <TableHead>Categoría</TableHead>
                <TableHead>Estado</TableHead>
                <SortableHead k="casos" label="Casos" right {...{ q, f, sort, dir }} />
                <SortableHead k="ultimo" label="Último caso" {...{ q, f, sort, dir }} />
                <SortableHead k="ritmo" label="Ritmo" {...{ q, f, sort, dir }} />
                <SortableHead k="health" label="Health" right {...{ q, f, sort, dir }} />
                <SortableHead
                  k="prioridad"
                  label="Prioridad"
                  right
                  {...{ q, f, sort, dir }}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {doctors.map((d) => (
                <TableRow key={d.id} className="cursor-pointer">
                  <TableCell>
                    <Link
                      href={`/doctores/${d.id}`}
                      className="block font-medium hover:underline"
                    >
                      <span className="flex items-center gap-1.5">
                        {d.nombre}
                        {!d.phone && !d.whatsapp ? (
                          <PhoneOff
                            className="h-3 w-3 text-muted-foreground/60"
                            aria-label="Sin teléfono"
                          />
                        ) : null}
                      </span>
                      {d.city ? (
                        <span className="text-xs font-normal text-muted-foreground">
                          {d.city}
                        </span>
                      ) : null}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-normal",
                        d.is_accredited
                          ? ACREDITACION_STYLES.si
                          : ACREDITACION_STYLES.no
                      )}
                      title={
                        d.accredited_at
                          ? `Acreditado el ${formatDate(d.accredited_at)}`
                          : undefined
                      }
                    >
                      {d.is_accredited ? "Acreditado" : "No acreditado"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn("font-normal", CATEGORIA_STYLES[d.categoria])}
                    >
                      {CATEGORIA_LABELS[d.categoria]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-normal",
                        LIFECYCLE_STYLES[d.lifecycle_stage]
                      )}
                    >
                      {LIFECYCLE_LABELS[d.lifecycle_stage]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.new_case_count}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {relativeDays(d.last_new_case_at)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {d.avg_interval_days
                      ? `cada ${Math.round(d.avg_interval_days)} días`
                      : "—"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      healthColor(d.health_score)
                    )}
                  >
                    {d.health_score ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {d.priority_score ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Página {page} de {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={`/doctores?${new URLSearchParams({
                  ...(q ? { q } : {}),
                  ...(f !== "todos" ? { f } : {}),
                  // el orden elegido viaja con la página: sin esto la página 2
                  // vuelve al orden por defecto y no continúa a la página 1
                  ...(sort !== "prioridad" ? { sort } : {}),
                  ...(dir ? { dir } : {}),
                  p: String(page - 1),
                })}`}
              >
                Anterior
              </Link>
            ) : null}
            {page < pages ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={`/doctores?${new URLSearchParams({
                  ...(q ? { q } : {}),
                  ...(f !== "todos" ? { f } : {}),
                  ...(sort !== "prioridad" ? { sort } : {}),
                  ...(dir ? { dir } : {}),
                  p: String(page + 1),
                })}`}
              >
                Siguiente
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

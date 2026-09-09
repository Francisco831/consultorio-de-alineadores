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
  ACTIVIDAD_STYLES,
  CATEGORIA_LABELS,
  CATEGORIA_STYLES,
  estiloSegmento,
  formatDate,
  healthColor,
  relativeDays,
} from "@/lib/format";
import {
  ACTIVIDAD_LABELS,
  SEGMENTO_DEFINICION,
  SEGMENTO_LABELS,
  type Actividad90d,
  type Doctor,
  type Segmento,
} from "@/lib/types";
import { explicarSegmento } from "@/lib/segmento";
import { todayMX } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Search, PhoneOff } from "lucide-react";

const PAGE_SIZE = 50;

// columnas ordenables: clave de URL → columna de la DB
const SORTS: Record<string, { col: string; label: string }> = {
  prioridad: { col: "priority_score", label: "Prioridad" },
  casos: { col: "new_case_count", label: "Casos" },
  nuevos: { col: "nuevos_90d", label: "Nuevos 90d" },
  etapas: { col: "posteriores_90d", label: "Etapas 90d" },
  ultimo: { col: "last_new_case_at", label: "Último caso" },
  ritmo: { col: "avg_interval_days", label: "Ritmo" },
  health: { col: "health_score", label: "Health" },
};

// ESTA PANTALLA ES EL ÁREA "ACREDITADOS", entera. El corte no es un tab que se pueda
// desmarcar: la consulta de abajo agrega `.eq("is_accredited", true)` siempre. Los
// doctores por acreditarse tienen su propia lista en /prospeccion/lista, con las
// columnas que les corresponden.
//
// Los tabs de acá adentro filtran por ESTADO: la matriz Potencial × Afinidad del
// Plan Comercial 2026 (migración 0058), que la base calcula desde el último caso
// que el doctor aprobó y su fecha de acreditación. Hasta el 8/9 filtraban por
// lifecycle_stage —las catorce etapas del motor—, que nadie del equipo usaba
// para decidir qué hacer. El lifecycle sigue debajo (score, automatizaciones,
// /hoy); en esta pantalla ya no se muestra.
// "sigue-instagram" no es un estado sino un hecho del canal: lo pone
// scripts/tag-seguidores-ig.ts desde el censo de seguidores del 20/8. Por eso
// filtra por tag y no por segmento.
const TAG_IG = "sigue-instagram";

// El EJE DE ACTIVIDAD (migración 0055) es otro eje que el lifecycle, y por eso
// va en su propia fila: se cruzan, no se reemplazan. Un caso del CRM es una
// ETAPA de un tratamiento — 'I_1' es un paciente nuevo, I_2 en adelante es el
// mismo paciente avanzando —, así que un doctor puede estar mandando trabajo
// todos los meses sin traer un solo paciente. "Solo termina" es exactamente
// ese doctor, y hasta 0055 el CRM lo daba por dormido.
const ACTIVIDADES: { key: Actividad90d; label: string }[] = [
  { key: "trae_nuevos", label: ACTIVIDAD_LABELS.trae_nuevos },
  { key: "solo_termina", label: ACTIVIDAD_LABELS.solo_termina },
  { key: "sin_actividad", label: ACTIVIDAD_LABELS.sin_actividad },
];

const FILTERS: {
  key: string;
  label: string;
  segmento?: Segmento;
  tag?: string;
}[] = [
  { key: "todos", label: "Todos" },
  { key: "activos", label: "Activos", segmento: "activo" },
  { key: "lapsed", label: "Lapsed", segmento: "lapsed" },
  { key: "beginners", label: "Beginners", segmento: "beginner" },
  { key: "inactivos", label: "Inactivos", segmento: "inactivo" },
  { key: "ig", label: "Te siguen en IG", tag: TAG_IG },
];

function SortableHead({
  k,
  label,
  right,
  q,
  f,
  a,
  sort,
  dir,
}: {
  k: string;
  label: string;
  right?: boolean;
  q: string;
  f: string;
  a: string;
  sort: string;
  dir?: string;
}) {
  const active = sort === k;
  // primer click ordena descendente (lo útil: más casos primero); segundo, asc
  const nextDir = active && dir !== "asc" ? "asc" : undefined;
  const params = new URLSearchParams({
    ...(q ? { q } : {}),
    ...(f !== "todos" ? { f } : {}),
    ...(a ? { a } : {}),
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
    a?: string;
    p?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const { q = "", f = "todos", a = "", p = "1", sort = "prioridad", dir } =
    await searchParams;
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
  if (filter?.segmento) query = query.eq("segmento", filter.segmento);
  if (filter?.tag) query = query.contains("tags", [filter.tag]);
  if (ACTIVIDADES.some((x) => x.key === a)) query = query.eq("actividad_90d", a);

  const { data, count, error } = await query;

  // los contadores del eje y del estado son del país entero, no de la búsqueda:
  // son la foto de la cartera acreditada y tienen que dar siempre lo mismo
  const contar = (col: "actividad_90d" | "segmento", valor: string) =>
    supabase
      .from("doctors")
      .select("id", { count: "exact", head: true })
      .eq("is_accredited", true)
      .eq("is_demo", false)
      .eq(col, valor);
  const [cTrae, cSolo, cSin, cAct, cLap, cBeg, cIna] = await Promise.all([
    contar("actividad_90d", "trae_nuevos"),
    contar("actividad_90d", "solo_termina"),
    contar("actividad_90d", "sin_actividad"),
    contar("segmento", "activo"),
    contar("segmento", "lapsed"),
    contar("segmento", "beginner"),
    contar("segmento", "inactivo"),
  ]);
  const CONTEO: Record<Actividad90d, number | null> = {
    trae_nuevos: cTrae.count,
    solo_termina: cSolo.count,
    sin_actividad: cSin.count,
  };
  const CONTEO_ESTADO: Record<Segmento, number | null> = {
    activo: cAct.count,
    lapsed: cLap.count,
    beginner: cBeg.count,
    inactivo: cIna.count,
  };
  const hoy = todayMX();
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

      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[13px] text-muted-foreground">
          Últimos 90 días:
        </span>
        {ACTIVIDADES.map((x) => (
          <Link
            key={x.key}
            href={`/doctores?${new URLSearchParams({
              ...(q ? { q } : {}),
              ...(f !== "todos" ? { f } : {}),
              ...(a === x.key ? {} : { a: x.key }),
            })}`}
            className={cn(
              buttonVariants({
                variant: a === x.key ? "secondary" : "ghost",
                size: "sm",
              }),
              "h-8 gap-1.5 text-[13px]"
            )}
          >
            {x.label}
            <span className="tabular-nums text-muted-foreground">
              {CONTEO[x.key] ?? "—"}
            </span>
          </Link>
        ))}
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
          {a ? <input type="hidden" name="a" value={a} /> : null}
        </form>
        <div className="flex gap-1">
          {FILTERS.map((x) => (
            <Link
              key={x.key}
              href={`/doctores?${new URLSearchParams({
                ...(q ? { q } : {}),
                ...(x.key !== "todos" ? { f: x.key } : {}),
                ...(a ? { a } : {}),
              })}`}
              className={cn(
                buttonVariants({
                  variant: f === x.key ? "secondary" : "ghost",
                  size: "sm",
                }),
                "h-8 gap-1.5 text-[13px]"
              )}
              title={x.segmento ? SEGMENTO_DEFINICION[x.segmento] : undefined}
            >
              {x.label}
              {x.segmento ? (
                <span className="tabular-nums text-muted-foreground">
                  {CONTEO_ESTADO[x.segmento] ?? "—"}
                </span>
              ) : null}
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
                <SortableHead k="casos" label="Casos" right {...{ q, f, a, sort, dir }} />
                <SortableHead
                  k="nuevos"
                  label="Nuevos 90d"
                  right
                  {...{ q, f, a, sort, dir }}
                />
                <SortableHead
                  k="etapas"
                  label="Etapas 90d"
                  right
                  {...{ q, f, a, sort, dir }}
                />
                <SortableHead k="ultimo" label="Último caso" {...{ q, f, a, sort, dir }} />
                <SortableHead k="ritmo" label="Ritmo" {...{ q, f, a, sort, dir }} />
                <SortableHead k="health" label="Health" right {...{ q, f, a, sort, dir }} />
                <SortableHead
                  k="prioridad"
                  label="Prioridad"
                  right
                  {...{ q, f, a, sort, dir }}
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
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge
                        variant="outline"
                        className={cn("font-normal", estiloSegmento(d.segmento))}
                        title={d.segmento ? SEGMENTO_DEFINICION[d.segmento] : undefined}
                      >
                        {d.segmento ? SEGMENTO_LABELS[d.segmento] : "Sin calcular"}
                      </Badge>
                      {d.actividad_90d === "solo_termina" ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-normal",
                            ACTIVIDAD_STYLES.solo_termina
                          )}
                          title={`Mandó ${d.posteriores_90d + d.servicio_90d} etapa(s) en 90 días sin traer un paciente nuevo`}
                        >
                          Se apaga
                        </Badge>
                      ) : null}
                    </div>
                    {/* la acción asociada al estado, como dato secundario: qué
                        hacer con este doctor y el hecho del que sale */}
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {explicarSegmento(d, hoy)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.new_case_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.nuevos_90d || (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums"
                    title={
                      d.servicio_90d
                        ? `${d.servicio_90d} de contención, pasivas o superposición`
                        : undefined
                    }
                  >
                    {d.posteriores_90d + d.servicio_90d || (
                      <span className="text-muted-foreground">0</span>
                    )}
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
                  ...(a ? { a } : {}),
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
                  ...(a ? { a } : {}),
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

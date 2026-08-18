import Link from "next/link";
import { Search, PhoneOff } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { relativeDays } from "@/lib/format";
import { ACQ_STAGE_LABELS, type AcqStage, type Doctor } from "@/lib/types";

// La lista del área "POR ACREDITARSE". Hasta ahora no existía: el link de la
// columna desbordada del kanban mandaba a /doctores con un filtro, o sea a la
// lista del OTRO área.
//
// Las columnas no son las de /doctores a propósito. Casos históricos, ritmo y
// categoría le muestran cero a alguien que todavía no pudo mandar un caso; acá
// las que importan son en qué etapa está, cuánto interés hay y hace cuánto que
// nadie lo toca.

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Un tab por etapa del pipeline de adquisición, más "Todos". 'acreditado' no
// aparece: un doctor en esa etapa ya cruzó de área y vive en /doctores.
const ETAPAS: AcqStage[] = [
  "identificado",
  "contacto_intentado",
  "contactado",
  "calificado",
  "reunion_agendada",
  "reunion_realizada",
  "interes_acreditacion",
  "acreditacion_agendada",
  "no_interesado",
];

function Interes({ n }: { n: number | null }) {
  if (!n) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn(
        "tabular-nums",
        n >= 4 ? "text-emerald-400" : n <= 2 ? "text-muted-foreground" : undefined
      )}
      title={`${n} de 5`}
    >
      {"●".repeat(n)}
      <span className="text-muted-foreground/40">{"●".repeat(5 - n)}</span>
    </span>
  );
}

export default async function ProspeccionListaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; f?: string; p?: string }>;
}) {
  const { q = "", f = "todos", p = "1" } = await searchParams;
  const page = Math.max(1, parseInt(p) || 1);
  const supabase = await createClient();

  let query = supabase
    .from("doctors")
    .select("*", { count: "exact" })
    // el corte del área, no negociable desde la URL
    .eq("is_accredited", false)
    .order("priority_score", { ascending: false, nullsFirst: false })
    .order("nombre", { ascending: true })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (q) query = query.ilike("nombre", `%${q}%`);
  if (f !== "todos" && (ETAPAS as string[]).includes(f))
    query = query.eq("acquisition_stage", f);

  const { data, count, error } = await query;
  const doctores = (data ?? []) as Doctor[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const url = (extra: Record<string, string>) =>
    `/prospeccion/lista?${new URLSearchParams({
      ...(q ? { q } : {}),
      ...(f !== "todos" ? { f } : {}),
      ...extra,
    })}`;

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Por acreditarse</h1>
        <p className="text-sm text-muted-foreground">
          {total} {total === 1 ? "doctor" : "doctores"} ·{" "}
          <Link href="/prospeccion" className="hover:underline">
            ver el pipeline
          </Link>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form className="relative" action="/prospeccion/lista">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Buscar doctor…"
            className="h-9 w-64 pl-8"
          />
          {f !== "todos" ? <input type="hidden" name="f" value={f} /> : null}
        </form>
        <div className="flex flex-wrap gap-1">
          {[{ key: "todos", label: "Todos" }, ...ETAPAS.map((e) => ({ key: e, label: ACQ_STAGE_LABELS[e] }))].map(
            (x) => (
              <Link
                key={x.key}
                href={`/prospeccion/lista?${new URLSearchParams({
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
            )
          )}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          Error cargando la lista: {error.message}
        </p>
      ) : doctores.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {q
            ? `Ningún doctor por acreditarse coincide con “${q}”.`
            : "No hay doctores en esta etapa."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Doctor</TableHead>
                <TableHead>Etapa</TableHead>
                <TableHead>Especialidad</TableHead>
                <TableHead>Interés</TableHead>
                <TableHead className="text-right">Casos/mes est.</TableHead>
                <TableHead>Último contacto</TableHead>
                <TableHead className="text-right">Prioridad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {doctores.map((d) => (
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
                    <Badge variant="outline" className="font-normal">
                      {d.acquisition_stage
                        ? ACQ_STAGE_LABELS[d.acquisition_stage]
                        : "Sin etapa"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {d.specialty ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Interes n={d.accreditation_interest ?? d.interest_level} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                    {d.estimated_cases_month ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {relativeDays(d.last_contact_at)}
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
                href={url({ p: String(page - 1) })}
              >
                Anterior
              </Link>
            ) : null}
            {page < pages ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={url({ p: String(page + 1) })}
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

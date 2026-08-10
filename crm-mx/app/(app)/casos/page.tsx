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
  formatDate,
  relativeDays,
  formatEtapa,
  formatTipoTratamiento,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";

const PAGE_SIZE = 50;

interface CaseRow {
  id: string;
  id_externo: string | null;
  noloco_case_id: string;
  paciente: string | null;
  etapa: string | null;
  tipo_tratamiento: string | null;
  tipo_caso: string | null;
  alineadores_total: number | null;
  is_new_case: boolean;
  fecha_ingreso: string;
  fecha_aprobacion: string | null;
  fecha_video: string | null;
  fecha_aprobacion_video: string | null;
  doctor_id: string;
  doctors: { nombre: string } | null;
}

export default async function CasosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; f?: string; p?: string }>;
}) {
  const { q = "", f = "todos", p = "1" } = await searchParams;
  const page = Math.max(1, parseInt(p) || 1);
  const supabase = await createClient();

  let query = supabase
    .from("cases")
    .select("id, id_externo, noloco_case_id, paciente, etapa, tipo_tratamiento, tipo_caso, alineadores_total, is_new_case, fecha_ingreso, fecha_aprobacion, fecha_video, fecha_aprobacion_video, doctor_id, doctors(nombre)", {
      count: "exact",
    })
    .order("fecha_ingreso", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (q) query = query.ilike("paciente", `%${q}%`);
  if (f === "nuevos") query = query.eq("is_new_case", true);
  if (f === "aprobacion") {
    query = query.not("fecha_video", "is", null).is("fecha_aprobacion_video", null);
  }

  const { data, count } = await query;
  const cases = (data ?? []) as unknown as CaseRow[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filters = [
    { key: "todos", label: "Todos" },
    { key: "nuevos", label: "Casos nuevos (1ª etapa)" },
    { key: "aprobacion", label: "Pendientes de aprobación" },
  ];

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Casos</h1>
        <p className="text-sm text-muted-foreground">
          Espejo de producción (Noloco), solo lectura · {total} casos
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form className="relative" action="/casos">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Buscar paciente…"
            className="h-9 w-64 pl-8"
          />
          {f !== "todos" ? <input type="hidden" name="f" value={f} /> : null}
        </form>
        <div className="flex gap-1">
          {filters.map((x) => (
            <Link
              key={x.key}
              href={`/casos?${new URLSearchParams({
                ...(q ? { q } : {}),
                ...(x.key !== "todos" ? { f: x.key } : {}),
              })}`}
              className={cn(
                buttonVariants({
                  variant: f === x.key ? "secondary" : "ghost",
                  size: "sm",
                })
              )}
            >
              {x.label}
            </Link>
          ))}
        </div>
      </div>

      {cases.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {f === "aprobacion"
            ? "No hay videos pendientes de aprobación. Excelente."
            : "Sin casos. Corré el import de Noloco."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Caso</TableHead>
                <TableHead>Paciente</TableHead>
                <TableHead>Doctor</TableHead>
                <TableHead>Etapa</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Ingreso</TableHead>
                <TableHead>Video</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.map((c) => {
                const videoPendiente =
                  c.fecha_video != null && c.fecha_aprobacion_video == null;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.id_externo ?? c.noloco_case_id}
                      {c.is_new_case ? (
                        <Badge
                          variant="outline"
                          className="ml-2 font-normal text-emerald-700 dark:text-emerald-400"
                        >
                          Nuevo
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{c.paciente ?? "—"}</TableCell>
                    <TableCell>
                      <Link
                        href={`/doctores/${c.doctor_id}`}
                        className="hover:underline"
                      >
                        {c.doctors?.nombre ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatEtapa(c.etapa)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.tipo_caso ?? formatTipoTratamiento(c.tipo_tratamiento)}
                      {c.alineadores_total ? (
                        <span className="ml-1 text-xs">
                          · {c.alineadores_total} alin
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(c.fecha_ingreso)}
                    </TableCell>
                    <TableCell>
                      {videoPendiente ? (
                        <span className="text-sm text-orange-600 dark:text-orange-400">
                          Sin aprobar {relativeDays(c.fecha_video)}
                        </span>
                      ) : c.fecha_aprobacion_video ? (
                        <span className="text-sm text-muted-foreground">
                          Aprobado
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
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
                href={`/casos?${new URLSearchParams({
                  ...(q ? { q } : {}),
                  ...(f !== "todos" ? { f } : {}),
                  p: String(page - 1),
                })}`}
              >
                Anterior
              </Link>
            ) : null}
            {page < pages ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={`/casos?${new URLSearchParams({
                  ...(q ? { q } : {}),
                  ...(f !== "todos" ? { f } : {}),
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

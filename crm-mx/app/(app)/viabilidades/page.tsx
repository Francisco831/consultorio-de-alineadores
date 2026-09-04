import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CargarViabilidad } from "@/components/viabilidades/cargar-viabilidad";
import { RegistrarViabilidad } from "@/components/seguimiento/registrar-viabilidad";
import { formatDate } from "@/lib/format";
import { VIABILITY_STATUS_LABELS, type ViabilityStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// QUÉ ES UNA VIABILIDAD, en los datos. No hay columna que lo diga. Las 38 que
// existen entraron en el import del 8/8/26 y se reconocen por dónde quedaron:
// las abiertas están en la etapa 'viabilidad', las que no llegaron a caso las
// cerró el reloj del import con lost_reason 'Viabilidad no convertida', y las
// que sí llegaron quedaron en 'ganada' con case_id. Las que se carguen de acá
// en adelante traen `viability_requested_at`, que es la marca de verdad y no
// una inferencia — con el tiempo el criterio legacy se puede retirar.
const LOST_VIABILIDAD = "Viabilidad no convertida";

type Fila = {
  id: string;
  stage: string;
  patient_name: string | null;
  case_id: string | null;
  lost_reason: string | null;
  closed_at: string | null;
  created_at: string;
  stage_entered_at: string | null;
  viability_requested_at: string | null;
  viability_status: ViabilityStatus | null;
  viability_result: string | null;
  doctors: { id: string; nombre: string } | null;
  cases: { id_externo: string | null; fecha_ingreso: string } | null;
};

function esViabilidad(o: Fila): boolean {
  return (
    o.viability_requested_at != null ||
    o.stage === "viabilidad" ||
    o.lost_reason === LOST_VIABILIDAD ||
    (o.stage === "ganada" && o.case_id != null)
  );
}

/** El reloj: cuándo se pidió. Si nadie lo cargó, cuándo entró a la etapa. */
function pedida(o: Fila): string {
  return o.viability_requested_at ?? o.stage_entered_at ?? o.created_at;
}

function dias(desde: string, hasta?: string | null): number {
  const fin = hasta ? Date.parse(hasta) : Date.now();
  return Math.floor((fin - Date.parse(desde)) / 86_400_000);
}

type Estado = "esperando" | "sin_caso" | "convertida" | "no_convertida";

const ESTADOS: Record<Estado, { label: string; ayuda: string; clase: string }> = {
  esperando: {
    label: "Nos esperan a nosotros",
    ayuda: "Se pidió la viabilidad y el equipo clínico todavía no contestó.",
    clase: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-400 dark:border-orange-900",
  },
  sin_caso: {
    label: "Esperamos al doctor",
    ayuda: "Ya se contestó. La pelota está del lado del doctor y el caso no llegó.",
    clase: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-900",
  },
  convertida: {
    label: "Convirtió en caso",
    ayuda: "Terminó en un caso ingresado.",
    clase: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-900",
  },
  no_convertida: {
    label: "No convirtió",
    ayuda: "Se cerró sin caso.",
    clase: "bg-muted text-muted-foreground border-transparent",
  },
};

function estadoDe(o: Fila): Estado {
  if (o.case_id != null || o.stage === "ganada") return "convertida";
  if (o.stage === "perdida") return "no_convertida";
  if (o.viability_status === "respondida") return "sin_caso";
  return "esperando";
}

export default async function ViabilidadesPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { e = "" } = await searchParams;
  const supabase = await createClient();

  // se traen todas y se filtra acá: la tabla entera son decenas de filas, y el
  // criterio de "qué es una viabilidad" son cuatro condiciones que en un `.or()`
  // de PostgREST se leen mucho peor de lo que se corrigen
  const { data, error } = await supabase
    .from("opportunities")
    .select(
      "id, stage, patient_name, case_id, lost_reason, closed_at, created_at, stage_entered_at, viability_requested_at, viability_status, viability_result, doctors(id, nombre), cases(id_externo, fecha_ingreso)"
    )
    .order("created_at", { ascending: false });

  const todas = ((data ?? []) as unknown as Fila[]).filter(esViabilidad);
  const porEstado = (x: Estado) => todas.filter((o) => estadoDe(o) === x);
  const conteo: Record<Estado, number> = {
    esperando: porEstado("esperando").length,
    sin_caso: porEstado("sin_caso").length,
    convertida: porEstado("convertida").length,
    no_convertida: porEstado("no_convertida").length,
  };

  const cerradas = conteo.convertida + conteo.no_convertida;
  const tasa = cerradas ? Math.round((conteo.convertida / cerradas) * 100) : null;

  const filtro = (Object.keys(ESTADOS) as Estado[]).includes(e as Estado)
    ? (e as Estado)
    : null;
  const visibles = (filtro ? porEstado(filtro) : todas)
    .slice()
    .sort((a, b) => Date.parse(pedida(b)) - Date.parse(pedida(a)));

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Viabilidades</h1>
        <p className="text-sm text-muted-foreground">
          El pedido previo al caso: se carga acá, sin entrar doctor por doctor, y
          se sigue hasta saber si terminó en un caso o no.
        </p>
      </div>

      <CargarViabilidad />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(ESTADOS) as Estado[]).map((k) => (
          <Link
            key={k}
            href={filtro === k ? "/viabilidades" : `/viabilidades?e=${k}`}
            className={cn(
              "rounded-lg border p-3 transition-colors hover:bg-muted/50",
              filtro === k && "ring-2 ring-ring"
            )}
          >
            <div className="text-2xl font-semibold tabular-nums">
              {conteo[k]}
            </div>
            <div className="text-sm font-medium">{ESTADOS[k].label}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {ESTADOS[k].ayuda}
            </p>
          </Link>
        ))}
      </div>

      {tasa != null ? (
        <p className="text-sm text-muted-foreground">
          De las {cerradas} viabilidades que ya se cerraron, {conteo.convertida}{" "}
          terminaron en caso: <strong className="text-foreground">{tasa}%</strong>
          . Las que siguen abiertas no cuentan todavía.
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive">
          Error cargando viabilidades: {error.message}
        </p>
      ) : visibles.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtro
            ? `Ninguna viabilidad en “${ESTADOS[filtro].label}”.`
            : "Todavía no hay viabilidades cargadas."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Doctor</TableHead>
                <TableHead>Paciente</TableHead>
                <TableHead>Se pidió</TableHead>
                <TableHead className="text-right">Días</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Caso</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibles.map((o) => {
                const est = estadoDe(o);
                const abierta = est === "esperando" || est === "sin_caso";
                const d = dias(pedida(o), abierta ? null : o.closed_at);
                return (
                  <TableRow key={o.id}>
                    <TableCell>
                      {o.doctors ? (
                        <Link
                          href={`/doctores/${o.doctors.id}`}
                          className="font-medium hover:underline"
                        >
                          {o.doctors.nombre}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Sin doctor</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {o.patient_name ?? (
                        <span className="text-muted-foreground">
                          Sin paciente
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(pedida(o))}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        abierta && d >= 7 && "font-medium text-orange-600"
                      )}
                    >
                      {d}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge
                          variant="outline"
                          className={cn("font-normal", ESTADOS[est].clase)}
                        >
                          {ESTADOS[est].label}
                        </Badge>
                        {o.viability_status ? (
                          <span className="text-xs text-muted-foreground">
                            {VIABILITY_STATUS_LABELS[o.viability_status]}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {o.cases?.id_externo ?? (o.case_id ? "sí" : "—")}
                    </TableCell>
                    <TableCell className="text-right">
                      {abierta ? (
                        <RegistrarViabilidad
                          opportunityId={o.id}
                          paciente={o.patient_name}
                          estadoActual={o.viability_status}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

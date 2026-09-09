import Link from "next/link";
import { Search } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { VIABILITY_STATUS_LABELS } from "@/lib/types";
import {
  ESTADOS,
  ORDEN_ESTADOS,
  abierta,
  coincide,
  esViabilidad,
  estadoDe,
  fechaIngreso,
  numerar,
  type EstadoViabilidad,
  type ViabilidadFila,
} from "@/lib/viabilidades";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Qué es una viabilidad, qué estado tiene y qué número del mes le toca vive en
// lib/viabilidades.ts (con tests). Acá solo se trae y se dibuja.

type Params = { e?: string; doctor?: string; paciente?: string };

/** URL de la pestaña conservando lo que no cambia: tarjeta y buscador van juntos. */
function href(p: Params): string {
  const q = new URLSearchParams();
  if (p.e) q.set("e", p.e);
  if (p.doctor) q.set("doctor", p.doctor);
  if (p.paciente) q.set("paciente", p.paciente);
  const s = q.toString();
  return s ? `/viabilidades?${s}` : "/viabilidades";
}

export default async function ViabilidadesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const { e = "", doctor = "", paciente = "" } = await searchParams;
  const supabase = await createClient();

  // se traen todas y se filtra acá: la tabla entera son decenas de filas, y el
  // criterio de "qué es una viabilidad" son cuatro condiciones que en un `.or()`
  // de PostgREST se leen mucho peor de lo que se corrigen. `profiles!owner_id`
  // es obligatorio: opportunities tiene DOS FKs a profiles (owner_id y
  // viability_clinical_owner) y sin el hint PostgREST no sabe cuál embeber.
  const { data, error } = await supabase
    .from("opportunities")
    .select(
      "id, stage, patient_name, case_id, lost_reason, closed_at, created_at, stage_entered_at, viability_requested_at, viability_status, doctors(id, nombre), asesor:profiles!owner_id(nombre), cases(id_externo)"
    )
    .order("created_at", { ascending: false });

  const universo = ((data ?? []) as unknown as ViabilidadFila[]).filter(
    esViabilidad
  );
  // el N° del mes es de TODAS las viabilidades: si se numerara lo que queda
  // después del buscador, buscar a una doctora renumeraría las suyas
  const numero = numerar(universo);
  const estado = new Map(
    universo.map((o) => [o.id, estadoDe(o)] as const)
  );

  const buscando = doctor.trim() !== "" || paciente.trim() !== "";
  const todas = universo.filter(
    (o) => coincide(o.doctors?.nombre, doctor) && coincide(o.patient_name, paciente)
  );
  const porEstado = (x: EstadoViabilidad) =>
    todas.filter((o) => estado.get(o.id) === x);
  const conteo = Object.fromEntries(
    ORDEN_ESTADOS.map((k) => [k, porEstado(k).length])
  ) as Record<EstadoViabilidad, number>;

  const cerradas = conteo.convertida + conteo.suspendida;
  const tasa = cerradas ? Math.round((conteo.convertida / cerradas) * 100) : null;

  const filtro = ORDEN_ESTADOS.includes(e as EstadoViabilidad)
    ? (e as EstadoViabilidad)
    : null;
  // más nueva arriba; dentro del mismo día, el número más alto arriba
  const visibles = (filtro ? porEstado(filtro) : todas)
    .slice()
    .sort(
      (a, b) =>
        Date.parse(fechaIngreso(b)) - Date.parse(fechaIngreso(a)) ||
        (numero.get(b.id) ?? 0) - (numero.get(a.id) ?? 0)
    );

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
        {ORDEN_ESTADOS.map((k) => (
          <Link
            key={k}
            href={href({ e: filtro === k ? "" : k, doctor, paciente })}
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

      <form action="/viabilidades" className="flex flex-wrap items-end gap-2">
        {filtro ? <input type="hidden" name="e" value={filtro} /> : null}
        <div className="space-y-1">
          <label htmlFor="b-doctor" className="text-xs text-muted-foreground">
            Doctor
          </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="b-doctor"
              name="doctor"
              defaultValue={doctor}
              placeholder="Buscar por doctor…"
              className="h-9 w-56 pl-8"
              autoComplete="off"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="b-paciente" className="text-xs text-muted-foreground">
            Paciente
          </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="b-paciente"
              name="paciente"
              defaultValue={paciente}
              placeholder="Buscar por paciente…"
              className="h-9 w-56 pl-8"
              autoComplete="off"
            />
          </div>
        </div>
        <Button type="submit" variant="secondary" size="sm" className="h-9">
          Buscar
        </Button>
        {buscando ? (
          <Link
            href={href({ e: filtro ?? "" })}
            className="h-9 px-2 text-sm leading-9 text-muted-foreground hover:underline"
          >
            Limpiar
          </Link>
        ) : null}
      </form>

      {error ? (
        <p className="text-sm text-destructive">
          Error cargando viabilidades: {error.message}
        </p>
      ) : visibles.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {buscando
            ? "Ninguna viabilidad coincide con la búsqueda."
            : filtro
              ? `Ninguna viabilidad en “${ESTADOS[filtro].label}”.`
              : "Todavía no hay viabilidades cargadas."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-right">N° del mes</TableHead>
                <TableHead>Fecha de ingreso</TableHead>
                <TableHead>Asesor</TableHead>
                <TableHead>Doctor</TableHead>
                <TableHead>Paciente</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibles.map((o) => {
                const est = estado.get(o.id) ?? "esperando";
                // al lado del estado, lo que lo explica: el caso si convirtió,
                // el paso del ciclo (solicitada/enviada/respondida…) si no
                const detalle =
                  est === "convertida"
                    ? (o.cases?.id_externo ?? null)
                    : o.viability_status
                      ? VIABILITY_STATUS_LABELS[o.viability_status]
                      : null;
                return (
                  <TableRow key={o.id}>
                    <TableCell className="text-right font-medium tabular-nums">
                      {numero.get(o.id)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDate(fechaIngreso(o))}
                    </TableCell>
                    <TableCell className="text-sm">
                      {o.asesor?.nombre ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
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
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge
                          variant="outline"
                          className={cn("font-normal", ESTADOS[est].clase)}
                          title={ESTADOS[est].ayuda}
                        >
                          {ESTADOS[est].label}
                        </Badge>
                        {detalle ? (
                          <span className="text-xs text-muted-foreground">
                            {detalle}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {abierta(est) ? (
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

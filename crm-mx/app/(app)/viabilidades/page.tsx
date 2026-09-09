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
import { PanelMensual, nombreMes } from "@/components/viabilidades/panel-mensual";
import { RegistrarViabilidad } from "@/components/seguimiento/registrar-viabilidad";
import { todayMX } from "@/lib/dates";
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
import {
  METRICA_OBJETIVO_VIABILIDADES,
  esDelMes,
  mapaObjetivos,
  resumenMensual,
} from "@/lib/viabilidades-mensual";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Qué es una viabilidad, qué estado tiene y qué número del mes le toca vive en
// lib/viabilidades.ts (con tests); el panel mensual de arriba, en
// lib/viabilidades-mensual.ts (con tests). Acá solo se trae y se dibuja.

/** `m` es un mes del panel ("YYYY-MM") y `e` un estado: los dos acotan la tabla. */
type Params = { e?: string; m?: string; doctor?: string; paciente?: string };

/** URL de la pestaña conservando lo que no cambia: panel y buscador van juntos. */
function href(p: Params): string {
  const q = new URLSearchParams();
  if (p.m) q.set("m", p.m);
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
  const { e = "", m = "", doctor = "", paciente = "" } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // se traen todas y se filtra acá: la tabla entera son decenas de filas, y el
  // criterio de "qué es una viabilidad" son cuatro condiciones que en un `.or()`
  // de PostgREST se leen mucho peor de lo que se corrigen. `profiles!owner_id`
  // es obligatorio: opportunities tiene DOS FKs a profiles (owner_id y
  // viability_clinical_owner) y sin el hint PostgREST no sabe cuál embeber.
  const [{ data, error }, { data: objetivosRaw }, { data: perfil }] =
    await Promise.all([
      supabase
        .from("opportunities")
        .select(
          "id, stage, patient_name, case_id, lost_reason, closed_at, created_at, stage_entered_at, viability_requested_at, viability_status, doctors(id, nombre), asesor:profiles!owner_id(nombre), cases(id_externo)"
        )
        .order("created_at", { ascending: false }),
      // el objetivo de conversión de cada mes (país), que se carga en /ajustes
      supabase
        .from("goals")
        .select("period, target")
        .eq("metric", METRICA_OBJETIVO_VIABILIDADES)
        .is("user_id", null),
      // solo para mostrarle el camino a Ajustes a quien puede cargar objetivos
      supabase.from("profiles").select("rol").eq("id", user!.id).maybeSingle(),
    ]);
  const esManager = ["ADMIN", "COUNTRY_MANAGER", "SALES_MANAGER"].includes(
    perfil?.rol ?? ""
  );

  const universo = ((data ?? []) as unknown as ViabilidadFila[]).filter(
    esViabilidad
  );
  // el N° del mes es de TODAS las viabilidades: si se numerara lo que queda
  // después del buscador, buscar a una doctora renumeraría las suyas
  const numero = numerar(universo);
  const estado = new Map(
    universo.map((o) => [o.id, estadoDe(o)] as const)
  );

  // el panel mensual es de TODAS las viabilidades, como la numeración: el
  // buscador acota la tabla, no la estadística del mes
  const mesActual = todayMX().slice(0, 7);
  const meses = resumenMensual(
    universo,
    mapaObjetivos(objetivosRaw ?? []),
    mesActual
  );

  const buscando = doctor.trim() !== "" || paciente.trim() !== "";
  const todas = universo.filter(
    (o) => coincide(o.doctors?.nombre, doctor) && coincide(o.patient_name, paciente)
  );
  const mes = /^\d{4}-\d{2}$/.test(m) ? m : null;
  const filtro = ORDEN_ESTADOS.includes(e as EstadoViabilidad)
    ? (e as EstadoViabilidad)
    : null;
  const delMes = mes ? todas.filter((o) => esDelMes(o, mes)) : todas;
  const porEstado = (x: EstadoViabilidad) =>
    delMes.filter((o) => estado.get(o.id) === x);
  // más nueva arriba; dentro del mismo día, el número más alto arriba
  const visibles = (filtro ? porEstado(filtro) : delMes)
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

      {/* El panel mensual (pedido 8/9/26) reemplaza los cuatro casilleros y la
          tasa global: mes por mes, cuántas entraron, en qué están hoy y cuántas
          convirtieron contra el objetivo. Cada número acota la tabla de abajo. */}
      <PanelMensual
        meses={meses}
        mesActual={mesActual}
        filtroMes={mes}
        filtroEstado={filtro}
        link={(mm, ee) => href({ m: mm ?? "", e: ee ?? "", doctor, paciente })}
        verAjustes={esManager}
      />

      <CargarViabilidad />

      <form action="/viabilidades" className="flex flex-wrap items-end gap-2">
        {mes ? <input type="hidden" name="m" value={mes} /> : null}
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
            href={href({ m: mes ?? "", e: filtro ?? "" })}
            className="h-9 px-2 text-sm leading-9 text-muted-foreground hover:underline"
          >
            Limpiar
          </Link>
        ) : null}
      </form>

      {(mes || filtro) && !error ? (
        <p className="text-sm text-muted-foreground">
          Mostrando {mes ? nombreMes(mes).toLowerCase() : "todos los meses"}
          {filtro ? ` · ${ESTADOS[filtro].label}` : ""} ({visibles.length}).{" "}
          <Link
            href={href({ doctor, paciente })}
            className="underline hover:text-foreground"
          >
            Ver todas
          </Link>
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive">
          Error cargando viabilidades: {error.message}
        </p>
      ) : visibles.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {buscando
            ? "Ninguna viabilidad coincide con la búsqueda."
            : filtro || mes
              ? `Ninguna viabilidad${mes ? ` de ${nombreMes(mes).toLowerCase()}` : ""}${filtro ? ` en “${ESTADOS[filtro].label}”` : ""}.`
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

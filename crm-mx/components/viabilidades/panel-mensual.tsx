// El panel mensual de /viabilidades (pedido de Pancho 8/9/26). Un renglón por
// mes: cuántas entraron, en qué estado están hoy, qué porcentaje convirtió y
// cuál era el objetivo de ese mes. Cada número es un link que filtra la tabla
// de abajo a ese mes y ese estado; el nombre del mes, al mes entero. Los
// estados y sus nombres salen de lib/viabilidades.ts, que es donde se cambian.
//
// Es un server component sin estado propio: la selección viaja por la URL,
// igual que el buscador de la página.

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ESTADOS,
  ORDEN_ESTADOS,
  type EstadoViabilidad,
} from "@/lib/viabilidades";
import {
  contraObjetivo,
  totalMensual,
  type MesViabilidades,
} from "@/lib/viabilidades-mensual";
import { cn } from "@/lib/utils";

/** "Septiembre de 2026" a partir de "2026-09". El día 15 evita cualquier borde de huso. */
export function nombreMes(mes: string): string {
  const s = new Date(`${mes}-15T12:00:00Z`).toLocaleDateString("es-MX", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Numero({
  n,
  href,
  activa,
  fuerte,
}: {
  n: number;
  href: string;
  activa: boolean;
  fuerte?: boolean;
}) {
  if (n === 0) return <span className="text-muted-foreground">0</span>;
  return (
    <Link
      href={href}
      className={cn(
        "inline-block min-w-8 rounded px-1.5 py-0.5 tabular-nums transition-colors hover:bg-muted",
        fuerte && "font-semibold",
        activa && "bg-muted font-semibold ring-1 ring-ring"
      )}
    >
      {n}
    </Link>
  );
}

function Conversion({
  m,
  enCurso,
}: {
  m: Pick<MesViabilidades, "tasa" | "objetivo">;
  enCurso: boolean;
}) {
  if (m.tasa == null) return <span className="text-muted-foreground">—</span>;
  const c = contraObjetivo(m);
  // el mes en curso no se pinta de rojo: lo que sigue abierto todavía puede convertir
  const clase =
    c === "cumple"
      ? "text-emerald-600 dark:text-emerald-400"
      : c === "no_cumple" && !enCurso
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";
  const ayuda = enCurso
    ? "Mes en curso: las que siguen abiertas todavía pueden convertir."
    : c === "cumple"
      ? "Llegó al objetivo del mes."
      : c === "no_cumple"
        ? "No llegó al objetivo del mes."
        : "Sin objetivo cargado para comparar.";
  return (
    <span className={cn("font-medium tabular-nums", clase)} title={ayuda}>
      {m.tasa}%
    </span>
  );
}

export function PanelMensual({
  meses,
  mesActual,
  filtroMes,
  filtroEstado,
  link,
  verAjustes,
}: {
  meses: MesViabilidades[];
  /** "YYYY-MM" de hoy en México: el único mes cuya conversión todavía se mueve */
  mesActual: string;
  filtroMes: string | null;
  filtroEstado: EstadoViabilidad | null;
  /** URL que deja la tabla de abajo en ese mes (o todos) y ese estado (o todos) */
  link: (mes: string | null, estado: EstadoViabilidad | null) => string;
  /** quien puede cargar objetivos ve el camino a Ajustes cuando falta alguno */
  verAjustes: boolean;
}) {
  const total = totalMensual(meses);
  const faltaObjetivo = meses.some((m) => m.objetivo == null);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Mes</TableHead>
              <TableHead
                className="text-right"
                title="Viabilidades cargadas ese mes, por su fecha de ingreso."
              >
                Ingresadas
              </TableHead>
              {ORDEN_ESTADOS.map((e) => (
                <TableHead key={e} className="text-right" title={ESTADOS[e].ayuda}>
                  {ESTADOS[e].label}
                </TableHead>
              ))}
              <TableHead
                className="text-right"
                title="Convertidas sobre ingresadas del mes."
              >
                Conversión
              </TableHead>
              <TableHead
                className="text-right"
                title="Tasa de conversión objetivo del mes. Se carga en Ajustes → Objetivos mensuales."
              >
                Objetivo
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {meses.map((m) => {
              const esteMes = filtroMes === m.mes;
              return (
                <TableRow key={m.mes} className={cn(esteMes && "bg-muted/40")}>
                  <TableCell className="whitespace-nowrap">
                    <Link
                      href={link(esteMes && !filtroEstado ? null : m.mes, null)}
                      className={cn(
                        "font-medium hover:underline",
                        esteMes && !filtroEstado && "underline"
                      )}
                    >
                      {nombreMes(m.mes)}
                    </Link>
                    {m.mes === mesActual ? (
                      <span className="ml-2 text-xs text-muted-foreground">en curso</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Numero
                      n={m.ingresadas}
                      href={link(m.mes, null)}
                      activa={esteMes && !filtroEstado}
                      fuerte
                    />
                  </TableCell>
                  {ORDEN_ESTADOS.map((e) => (
                    <TableCell key={e} className="text-right">
                      <Numero
                        n={m.porEstado[e]}
                        href={link(
                          esteMes && filtroEstado === e ? null : m.mes,
                          esteMes && filtroEstado === e ? null : e
                        )}
                        activa={esteMes && filtroEstado === e}
                      />
                    </TableCell>
                  ))}
                  <TableCell className="text-right">
                    <Conversion m={m} enCurso={m.mes >= mesActual} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.objetivo != null ? (
                      `${m.objetivo}%`
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          {meses.length > 1 ? (
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell>
                  <Link
                    href={link(null, null)}
                    className={cn(
                      "font-medium hover:underline",
                      !filtroMes && !filtroEstado && "underline"
                    )}
                  >
                    Total
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  <Numero
                    n={total.ingresadas}
                    href={link(null, null)}
                    activa={false}
                    fuerte
                  />
                </TableCell>
                {ORDEN_ESTADOS.map((e) => (
                  <TableCell key={e} className="text-right">
                    <Numero
                      n={total.porEstado[e]}
                      href={link(null, !filtroMes && filtroEstado === e ? null : e)}
                      activa={!filtroMes && filtroEstado === e}
                    />
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  <Conversion m={{ tasa: total.tasa, objetivo: null }} enCurso={false} />
                </TableCell>
                <TableCell className="text-right text-muted-foreground">—</TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Cada viabilidad cuenta en el mes de su fecha de ingreso, con el estado
        que tiene hoy. Conversión = convertidas sobre ingresadas del mes; en el
        mes en curso todavía se mueve.{" "}
        {faltaObjetivo ? (
          verAjustes ? (
            <>
              El objetivo de conversión de cada mes se carga en{" "}
              <Link href="/ajustes" className="underline hover:text-foreground">
                Ajustes → Objetivos mensuales
              </Link>
              .
            </>
          ) : (
            "Falta el objetivo de algún mes: lo carga un manager en Ajustes."
          )
        ) : null}
      </p>
    </div>
  );
}

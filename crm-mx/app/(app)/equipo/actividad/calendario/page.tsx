import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { todayMX } from "@/lib/dates";
import { fetchActividad, diaMX, MX_OFFSET } from "@/lib/actividad-equipo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Calendario mensual de actividad del equipo: cuánto cargó cada uno por día,
// con los contactos (llamadas, videollamadas, WhatsApp, visitas) resaltados.
// Click en un día → el detalle de ese día ("con quién hablé el 10 de julio").

function shiftMonth(m: string, months: number): string {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export default async function CalendarioActividadPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; u?: string }>;
}) {
  const params = await searchParams;
  const hoy = todayMX();
  const mesActual = hoy.slice(0, 7);
  const m = /^\d{4}-\d{2}$/.test(params.m ?? "") ? params.m! : mesActual;
  const u = params.u;

  const [y, mo] = m.split("-").map(Number);
  const diasEnMes = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  // lunes-domingo: getUTCDay da 0=domingo → corrido a 0=lunes
  const offsetPrimero = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
  const desde = `${m}-01T00:00:00${MX_OFFSET}`;
  const hasta = `${shiftMonth(m, 1)}-01T00:00:00${MX_OFFSET}`;

  const supabase = await createClient();
  const { items, profiles } = await fetchActividad(supabase, desde, hasta);
  const equipo = profiles.filter((p) => p.activo && p.rol !== "VIEWER");

  const totalPor = new Map<string, number>();
  for (const i of items)
    if (i.actor) totalPor.set(i.actor, (totalPor.get(i.actor) ?? 0) + 1);

  const visibles = u ? items.filter((i) => i.actor === u) : items;
  const porDia = new Map<string, { total: number; contactos: number }>();
  for (const i of visibles) {
    const dia = diaMX(i.ts);
    if (!porDia.has(dia)) porDia.set(dia, { total: 0, contactos: 0 });
    const c = porDia.get(dia)!;
    c.total++;
    if (i.esContacto) c.contactos++;
  }

  const nombreMes = new Date(`${m}-15T12:00:00Z`).toLocaleDateString("es-MX", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const conU = (mes: string) =>
    `/equipo/actividad/calendario?m=${mes}${u ? `&u=${u}` : ""}`;

  const celdas: (number | null)[] = [
    ...Array<null>(offsetPrimero).fill(null),
    ...Array.from({ length: diasEnMes }, (_, i) => i + 1),
  ];
  while (celdas.length % 7 !== 0) celdas.push(null);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Calendario de actividad
          </h1>
          <p className="text-sm text-muted-foreground">
            Cargas y contactos por día — click en un día para ver el detalle ·{" "}
            <Link
              href={`/equipo/actividad${u ? `?u=${u}` : ""}`}
              className="underline underline-offset-2"
            >
              vista por día
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={conU(shiftMonth(m, -1))}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            ←
          </Link>
          <span className="min-w-36 text-center text-sm font-medium capitalize">
            {nombreMes}
          </span>
          {m < mesActual ? (
            <Link
              href={conU(shiftMonth(m, 1))}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              →
            </Link>
          ) : null}
          {m !== mesActual ? (
            <Link
              href={conU(mesActual)}
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            >
              Este mes
            </Link>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href={`/equipo/actividad/calendario?m=${m}`}>
          <Badge variant={u ? "outline" : "default"}>
            Todos · {items.length}
          </Badge>
        </Link>
        {equipo.map((p) => (
          <Link key={p.id} href={`/equipo/actividad/calendario?m=${m}&u=${p.id}`}>
            <Badge variant={u === p.id ? "default" : "outline"}>
              {p.nombre} · {totalPor.get(p.id) ?? 0}
            </Badge>
          </Link>
        ))}
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid grid-cols-7 gap-1 pb-1 text-center text-xs font-medium text-muted-foreground">
            {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((dia) => (
              <div key={dia}>{dia}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {celdas.map((dia, idx) => {
              if (dia === null)
                return <div key={idx} className="min-h-20 rounded-md" />;
              const fecha = `${m}-${String(dia).padStart(2, "0")}`;
              const c = porDia.get(fecha);
              const esHoy = fecha === hoy;
              const futuro = fecha > hoy;
              return (
                <Link
                  key={idx}
                  href={`/equipo/actividad?d=${fecha}${u ? `&u=${u}` : ""}`}
                  className={cn(
                    "min-h-20 rounded-md border p-1.5 transition-colors hover:bg-accent",
                    esHoy && "border-primary",
                    futuro && "pointer-events-none opacity-40",
                    !c && !futuro && "bg-muted/30"
                  )}
                >
                  <div
                    className={cn(
                      "text-xs tabular-nums",
                      esHoy ? "font-semibold" : "text-muted-foreground"
                    )}
                  >
                    {dia}
                  </div>
                  {c ? (
                    <div className="mt-1 space-y-0.5">
                      {c.contactos > 0 ? (
                        <div className="rounded bg-blue-50 px-1 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-400">
                          {c.contactos} contacto{c.contactos === 1 ? "" : "s"}
                        </div>
                      ) : null}
                      <div className="px-1 text-xs text-muted-foreground">
                        {c.total} carga{c.total === 1 ? "" : "s"}
                      </div>
                    </div>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        &ldquo;Contactos&rdquo; = llamadas, videollamadas, WhatsApp, visitas,
        reuniones y KeepDays registrados. &ldquo;Cargas&rdquo; = todo lo demás
        también: tareas, oportunidades, eventos y ediciones de fichas.
      </p>
    </div>
  );
}

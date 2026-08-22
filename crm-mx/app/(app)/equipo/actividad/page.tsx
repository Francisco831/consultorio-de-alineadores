import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { todayMX } from "@/lib/dates";
import {
  fetchActividad,
  MX_OFFSET,
  MX_TZ,
  type ItemActividad,
} from "@/lib/actividad-equipo";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

// Actividad del equipo, día por día: qué cargó cada uno (Rocío, Juan…) en el
// CRM. La vista mensual vive en ./calendario; las fuentes, en lib/actividad-equipo.

const KIND_STYLE: Record<ItemActividad["kind"], string> = {
  actividad:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-900",
  tarea:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-900",
  tarea_ok:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-900",
  oportunidad:
    "bg-[#eaf6fe] text-[#001d57] border-[#cbf2fe] dark:bg-[#0e2a5c] dark:text-[#cbf2fe] dark:border-[#1d3f7e]",
  evento:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-400 dark:border-violet-900",
  edicion: "bg-muted text-muted-foreground border-transparent",
};

function shiftDay(d: string, days: number): string {
  return new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export default async function ActividadEquipoPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string; u?: string }>;
}) {
  const params = await searchParams;
  const hoy = todayMX();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(params.d ?? "") ? params.d! : hoy;
  const u = params.u;
  const desde = `${d}T00:00:00${MX_OFFSET}`;
  const hasta = `${shiftDay(d, 1)}T00:00:00${MX_OFFSET}`;

  const supabase = await createClient();
  const { items, profiles } = await fetchActividad(supabase, desde, hasta);
  const nombreDe = new Map(profiles.map((p) => [p.id, p.nombre]));

  const totalPor = new Map<string, number>();
  for (const i of items)
    if (i.actor) totalPor.set(i.actor, (totalPor.get(i.actor) ?? 0) + 1);

  const visibles = u ? items.filter((i) => i.actor === u) : items;
  const equipo = profiles.filter((p) => p.activo && p.rol !== "VIEWER");

  const horaMX = new Intl.DateTimeFormat("es-MX", {
    timeZone: MX_TZ,
    hour: "2-digit",
    minute: "2-digit",
  });
  const fechaLarga = new Date(`${d}T12:00:00Z`).toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const conU = (fecha: string) => `/equipo/actividad?d=${fecha}${u ? `&u=${u}` : ""}`;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Actividad del equipo
          </h1>
          <p className="text-sm text-muted-foreground">
            Todo lo que cargó cada persona en el CRM, día por día ·{" "}
            <Link
              href={`/equipo/actividad/calendario?m=${d.slice(0, 7)}${u ? `&u=${u}` : ""}`}
              className="underline underline-offset-2"
            >
              ver calendario
            </Link>{" "}
            ·{" "}
            <Link href="/equipo" className="underline underline-offset-2">
              volver a Equipo
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={conU(shiftDay(d, -1))}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            ←
          </Link>
          <form className="flex items-center gap-2">
            {u ? <input type="hidden" name="u" value={u} /> : null}
            <Input name="d" type="date" defaultValue={d} max={hoy} className="h-8 w-40" />
            <Button type="submit" size="sm" variant="outline">
              Ver
            </Button>
          </form>
          {d < hoy ? (
            <Link
              href={conU(shiftDay(d, 1))}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              →
            </Link>
          ) : null}
          {d !== hoy ? (
            <Link
              href={conU(hoy)}
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            >
              Hoy
            </Link>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href={`/equipo/actividad?d=${d}`}>
          <Badge variant={u ? "outline" : "default"}>
            Todos · {items.length}
          </Badge>
        </Link>
        {equipo.map((p) => (
          <Link key={p.id} href={`/equipo/actividad?d=${d}&u=${p.id}`}>
            <Badge variant={u === p.id ? "default" : "outline"}>
              {p.nombre} · {totalPor.get(p.id) ?? 0}
            </Badge>
          </Link>
        ))}
      </div>

      <p className="text-sm capitalize text-muted-foreground">{fechaLarga}</p>

      {visibles.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {u
            ? `${nombreDe.get(u) ?? "Esta persona"} no cargó nada este día.`
            : "Nadie cargó nada este día."}
        </p>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {visibles.map((i, idx) => (
            <div key={idx} className="flex items-start gap-3 px-4 py-2.5 text-sm">
              <span className="w-12 shrink-0 pt-0.5 tabular-nums text-muted-foreground">
                {horaMX.format(new Date(i.ts))}
              </span>
              <Badge className={`shrink-0 ${KIND_STYLE[i.kind]}`}>{i.badge}</Badge>
              <div className="min-w-0">
                {!u && i.actor ? (
                  <span className="font-medium">
                    {nombreDe.get(i.actor) ?? "—"}
                    {": "}
                  </span>
                ) : null}
                {i.doctor ? (
                  <>
                    <Link
                      href={`/doctores/${i.doctor.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {i.doctor.nombre}
                    </Link>
                    {" · "}
                  </>
                ) : null}
                <span className="text-muted-foreground">{i.text}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

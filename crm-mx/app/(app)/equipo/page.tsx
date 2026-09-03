import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { guardarMetasComercial } from "@/lib/actions/team";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { todayMX } from "@/lib/dates";
import { MX_OFFSET } from "@/lib/actividad-equipo";
import {
  TIPOS_CONTACTO,
  VENTANA_ATRIBUCION_DIAS,
  contarCasosPorPersona,
  desdeConVentana,
  indiceDeToques,
} from "@/lib/atribucion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Todo lo que se mide acá es del MES que se elige con ?m=YYYY-MM (antes era el
// mes en curso y nada más, y las actividades eran una ventana móvil de 30 días
// que en los primeros días del mes contradecía al panel de metas de abajo).
// Excepción: opps abiertas, tareas vencidas y último ingreso son estado de hoy
// —no existe "las opps abiertas de julio"— y se muestran igual en cualquier mes.

function shiftMonth(m: string, months: number): string {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export default async function EquipoPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const today = todayMX();
  const mesActual = today.slice(0, 7);
  const params = await searchParams;
  const m = /^\d{4}-\d{2}$/.test(params.m ?? "") ? params.m! : mesActual;
  const esMesActual = m === mesActual;

  // límites del mes en hora de México: con el borde en UTC, seis horas de cada
  // fin de mes caen del lado equivocado
  const desde = `${m}-01T00:00:00${MX_OFFSET}`;
  const hasta = `${shiftMonth(m, 1)}-01T00:00:00${MX_OFFSET}`;
  const period = `${m}-01`;

  const supabase = await createClient();

  const [
    { data: profiles },
    { data: monthCases },
    { data: openOpps },
    { data: overdueTasks },
    { data: goals },
    { data: actsMes },
    { data: toques },
  ] = await Promise.all([
    supabase.from("profiles").select("id, nombre, rol, activo").order("nombre"),
    // is_demo=false en las cuatro: ai_rep_performance() (0023) las filtra y acá no
    // se filtraban. El seed reparte lo sintético entre las personas reales por
    // nombre, así que el inflado no se diluye — cae entero sobre los que se miden.
    supabase
      .from("cases")
      .select("doctor_id, fecha_ingreso")
      .eq("is_new_case", true)
      .eq("is_demo", false)
      .gte("fecha_ingreso", desde)
      .lt("fecha_ingreso", hasta),
    supabase
      .from("opportunities")
      .select("owner_id")
      .eq("is_demo", false)
      .not("stage", "in", "(ganada,perdida)"),
    fetchAllRows<{ assigned_to: string | null }>((from, to) =>
      supabase
        .from("tasks")
        .select("assigned_to")
        .eq("status", "pendiente")
        .eq("is_demo", false)
        .lt("due_date", today)
        .range(from, to)
    ).then((data) => ({ data })),
    supabase
      .from("goals")
      .select("user_id, metric, target")
      .eq("period", period)
      .in("metric", ["paid_cases", "contactos", "videollamadas", "keepdays"]),
    // actividades del mes: alimentan tanto la tabla de arriba como el panel de
    // metas, para que los dos números no puedan discrepar
    fetchAllRows<{ created_by: string | null; type: string }>((from, to) =>
      supabase
        .from("activities")
        .select("created_by, type")
        .eq("is_demo", false)
        .gte("occurred_at", desde)
        .lt("occurred_at", hasta)
        .range(from, to)
    ).then((data) => ({ data })),
    // contactos para atribuir los casos del mes: arrancan 90 días ANTES del mes,
    // porque un caso de septiembre puede venir de una visita de julio
    fetchAllRows<{ doctor_id: string; created_by: string | null; occurred_at: string }>(
      (from, to) =>
        supabase
          .from("activities")
          .select("doctor_id, created_by, occurred_at")
          .eq("is_demo", false)
          .not("created_by", "is", null)
          .in("type", TIPOS_CONTACTO as unknown as string[])
          .gte("occurred_at", desdeConVentana(desde))
          .lt("occurred_at", hasta)
          .range(from, to)
    ).then((data) => ({ data })),
  ]);

  // último ingreso de cada uno (auth.users) — la función tiene gate de rol
  // adentro: para un rol sin gestión devuelve error y la columna no se muestra
  const { data: signins } = await supabase.rpc("team_signins");
  const lastSignIn = new Map<string, string | null>(
    ((signins ?? []) as { user_id: string; last_sign_in_at: string | null }[]).map(
      (s) => [s.user_id, s.last_sign_in_at]
    )
  );
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();
  const { data: myProfile } = currentUser
    ? await supabase.from("profiles").select("rol").eq("id", currentUser.id).single()
    : { data: null };
  const isManager = ["ADMIN", "COUNTRY_MANAGER", "SALES_MANAGER"].includes(
    myProfile?.rol ?? ""
  );

  const stats = new Map<
    string,
    { casos: number; opps: number; acts: number; visitas: number; keepdays: number; vencidas: number }
  >();
  const ensure = (id: string | null) => {
    if (!id) return null;
    if (!stats.has(id))
      stats.set(id, { casos: 0, opps: 0, acts: 0, visitas: 0, keepdays: 0, vencidas: 0 });
    return stats.get(id)!;
  };

  // el caso es de quien tocó al doctor, no de quien figura como owner hoy
  const { porPersona: casosDe, sinAtribuir } = contarCasosPorPersona(
    monthCases ?? [],
    indiceDeToques(toques ?? [])
  );
  for (const [persona, n] of casosDe) {
    const s = ensure(persona);
    if (s) s.casos = n;
  }
  for (const o of openOpps ?? []) {
    const s = ensure(o.owner_id);
    if (s) s.opps++;
  }
  for (const a of actsMes ?? []) {
    const s = ensure(a.created_by);
    if (s) {
      s.acts++;
      if (a.type === "visita") s.visitas++;
      if (a.type === "keepday") s.keepdays++;
    }
  }
  for (const t of overdueTasks ?? []) {
    const s = ensure(t.assigned_to);
    if (s) s.vencidas++;
  }
  const goalOf = new Map(
    (goals ?? [])
      .filter((g) => g.metric === "paid_cases")
      .map((g) => [g.user_id, g.target])
  );
  const metaDe = new Map(
    (goals ?? []).map((g) => [`${g.user_id}|${g.metric}`, g.target])
  );

  const CONTACTO_TYPES = new Set([
    "llamada",
    "videollamada",
    "whatsapp",
    "visita",
    "reunion",
  ]);
  const mes = new Map<string, { contactos: number; videollamadas: number; keepdays: number }>();
  for (const a of actsMes ?? []) {
    if (!a.created_by) continue;
    if (!mes.has(a.created_by))
      mes.set(a.created_by, { contactos: 0, videollamadas: 0, keepdays: 0 });
    const c = mes.get(a.created_by)!;
    if (CONTACTO_TYPES.has(a.type)) c.contactos++;
    // "reunion" sigue contando: era el tipo con el que se registraban las
    // videollamadas hasta que existió el tipo propio (0038)
    if (a.type === "videollamada" || a.type === "reunion") c.videollamadas++;
    if (a.type === "keepday") c.keepdays++;
  }

  const team = (profiles ?? []).filter((p) => p.activo);

  const nombreMes = new Date(`${m}-15T12:00:00Z`).toLocaleDateString("es-MX", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Equipo</h1>
          <p className="text-sm text-muted-foreground">
            Casos, actividades y metas de <span className="capitalize">{nombreMes}</span> ·{" "}
            <Link
              href={
                esMesActual
                  ? "/equipo/actividad"
                  : `/equipo/actividad/calendario?m=${m}`
              }
              className="underline underline-offset-2"
            >
              actividad por día →
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/equipo?m=${shiftMonth(m, -1)}`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            ←
          </Link>
          <span className="min-w-36 text-center text-sm font-medium capitalize">
            {nombreMes}
          </span>
          {m < mesActual ? (
            <Link
              href={`/equipo?m=${shiftMonth(m, 1)}`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              →
            </Link>
          ) : null}
          {!esMesActual ? (
            <Link
              href="/equipo"
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            >
              Este mes
            </Link>
          ) : null}
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Persona</TableHead>
              <TableHead className="text-right">Casos del mes</TableHead>
              <TableHead className="text-right">Objetivo</TableHead>
              <TableHead className="text-right">Opps abiertas</TableHead>
              <TableHead className="text-right">Actividades</TableHead>
              <TableHead className="text-right">Visitas</TableHead>
              <TableHead className="text-right">KeepDays</TableHead>
              <TableHead className="text-right">Tareas vencidas</TableHead>
              {signins ? <TableHead className="text-right">Último ingreso</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.map((p) => {
              const s = stats.get(p.id) ?? {
                casos: 0, opps: 0, acts: 0, visitas: 0, keepdays: 0, vencidas: 0,
              };
              const goal = goalOf.get(p.id);
              return (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="font-medium">{p.nombre}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{p.rol}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {s.casos}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {goal ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.opps}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.acts}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.visitas}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.keepdays}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.vencidas > 0 ? (
                      <span className="text-red-600 dark:text-red-400">{s.vencidas}</span>
                    ) : (
                      "0"
                    )}
                  </TableCell>
                  {signins ? (
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {lastSignIn.get(p.id)
                        ? new Date(lastSignIn.get(p.id)!).toLocaleString("es-MX", {
                            timeZone: "America/Mexico_City",
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "nunca entró"}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {sinAtribuir > 0 ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{sinAtribuir}</span> de los{" "}
          {monthCases?.length ?? 0} casos del mes quedaron{" "}
          <span className="font-medium">sin atribuir</span>: entraron sin ningún
          contacto cargado en el CRM en los {VENTANA_ATRIBUCION_DIAS} días previos.
          No se reparten entre el equipo — el hueco es el dato.
        </p>
      ) : null}
      <div className="space-y-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            Metas del comercial — <span className="capitalize">{nombreMes}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            Contactos (llamada + WhatsApp + visita + videollamada) ·
            videollamadas · KeepDays · casos del mes
            {isManager
              ? esMesActual
                ? " — las metas se estipulan acá mismo"
                : " — lo que se guarde acá queda en las metas de ese mes"
              : ""}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {team.map((p) => {
            const real = mes.get(p.id) ?? { contactos: 0, videollamadas: 0, keepdays: 0 };
            const casosReal = stats.get(p.id)?.casos ?? 0;
            const celdas: { label: string; name: string; real: number; meta: number | undefined }[] = [
              { label: "Contactos", name: "contactos", real: real.contactos, meta: metaDe.get(`${p.id}|contactos`) },
              { label: "Videollamadas", name: "videollamadas", real: real.videollamadas, meta: metaDe.get(`${p.id}|videollamadas`) },
              { label: "KeepDays", name: "keepdays", real: real.keepdays, meta: metaDe.get(`${p.id}|keepdays`) },
              { label: "Casos", name: "paid_cases", real: casosReal, meta: metaDe.get(`${p.id}|paid_cases`) },
            ];
            return (
              <div key={p.id} className="rounded-lg border bg-card p-4">
                <p className="mb-3 font-medium">{p.nombre}</p>
                <form action={guardarMetasComercial} className="space-y-2">
                  <input type="hidden" name="user_id" value={p.id} />
                  <input type="hidden" name="period" value={period} />
                  {celdas.map((c) => {
                    const cumple = c.meta !== undefined && c.real >= c.meta;
                    return (
                      <div key={c.name} className="flex items-center justify-between gap-2">
                        <span className="text-sm text-muted-foreground">{c.label}</span>
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              "text-sm font-medium tabular-nums " +
                              (c.meta === undefined
                                ? ""
                                : cumple
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "")
                            }
                          >
                            {c.real}
                            <span className="text-muted-foreground font-normal">
                              {" "}/ {c.meta ?? "—"}
                            </span>
                          </span>
                          {isManager ? (
                            <Input
                              type="number"
                              name={c.name}
                              min={0}
                              defaultValue={c.meta ?? ""}
                              placeholder="meta"
                              className="h-7 w-20 text-right text-xs"
                            />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {isManager ? (
                    <div className="pt-1 text-right">
                      <Button type="submit" size="sm" variant="outline">
                        Guardar metas
                      </Button>
                    </div>
                  ) : null}
                </form>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        “Casos del mes” son los casos nuevos (1ª etapa) del mes, y se le cuentan a
        quien tocó a ese doctor por última vez dentro de los{" "}
        {VENTANA_ATRIBUCION_DIAS} días anteriores al caso — llamada, videollamada,
        WhatsApp, visita, reunión o KeepDay. No se cuentan por owner del doctor:
        el owner es el estado de hoy y reasignar una cartera reescribía la
        historia. Actividades, visitas y KeepDays son las del mes elegido; opps
        abiertas, tareas vencidas y último ingreso son de hoy. Los objetivos por
        persona se cargan en la tabla goals (cuotas OKR: Juan 18 · Rocío 4→7 ·
        nuevo/a 2→5).
      </p>
    </div>
  );
}

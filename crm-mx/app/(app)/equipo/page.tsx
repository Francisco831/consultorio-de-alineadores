import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { guardarMetasComercial } from "@/lib/actions/team";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { todayMX, monthStartMX } from "@/lib/dates";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function EquipoPage() {
  const supabase = await createClient();
  const monthStartISO = monthStartMX();
  const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const today = todayMX();

  const [
    { data: profiles },
    { data: doctors },
    { data: monthCases },
    { data: openOpps },
    { data: acts30 },
    { data: overdueTasks },
    { data: goals },
    { data: actsMes },
  ] = await Promise.all([
    supabase.from("profiles").select("id, nombre, rol, activo").order("nombre"),
    // paginado: el mapa doctor→owner cruza los casos del mes. Con 6.4k doctores
    // un select plano trae 1.000 y desinfla los casos de todo el equipo
    fetchAllRows<{ id: string; owner_id: string | null }>((from, to) =>
      supabase.from("doctors").select("id, owner_id").range(from, to)
    ).then((data) => ({ data })),
    // is_demo=false en las cuatro: ai_rep_performance() (0023) las filtra y acá no
    // se filtraban. El seed reparte lo sintético entre las personas reales por
    // nombre, así que el inflado no se diluye — cae entero sobre los que se miden.
    supabase
      .from("cases")
      .select("doctor_id")
      .eq("is_new_case", true)
      .eq("is_demo", false)
      .gte("fecha_ingreso", monthStartISO),
    supabase
      .from("opportunities")
      .select("owner_id")
      .eq("is_demo", false)
      .not("stage", "in", "(ganada,perdida)"),
    // actividades y tareas vencidas también se cuentan por persona en JS
    fetchAllRows<{ created_by: string | null; type: string }>((from, to) =>
      supabase
        .from("activities")
        .select("created_by, type")
        .eq("is_demo", false)
        .gte("occurred_at", d30)
        .range(from, to)
    ).then((data) => ({ data })),
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
      .eq("period", monthStartISO)
      .in("metric", ["paid_cases", "contactos", "videollamadas", "keepdays"]),
    fetchAllRows<{ created_by: string | null; type: string }>((from, to) =>
      supabase
        .from("activities")
        .select("created_by, type")
        .eq("is_demo", false)
        .gte("occurred_at", monthStartISO)
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

  const ownerOf = new Map((doctors ?? []).map((d) => [d.id, d.owner_id]));
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

  for (const c of monthCases ?? []) {
    const s = ensure(ownerOf.get(c.doctor_id) ?? null);
    if (s) s.casos++;
  }
  for (const o of openOpps ?? []) {
    const s = ensure(o.owner_id);
    if (s) s.opps++;
  }
  for (const a of acts30 ?? []) {
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

  // reales del MES calendario para el panel de metas (la tabla de arriba usa 30d)
  const CONTACTO_TYPES = new Set(["llamada", "whatsapp", "visita", "reunion"]);
  const mes = new Map<string, { contactos: number; videollamadas: number; keepdays: number }>();
  for (const a of actsMes ?? []) {
    if (!a.created_by) continue;
    if (!mes.has(a.created_by))
      mes.set(a.created_by, { contactos: 0, videollamadas: 0, keepdays: 0 });
    const m = mes.get(a.created_by)!;
    if (CONTACTO_TYPES.has(a.type)) m.contactos++;
    if (a.type === "reunion") m.videollamadas++;
    if (a.type === "keepday") m.keepdays++;
  }

  const team = (profiles ?? []).filter((p) => p.activo);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Equipo</h1>
          <p className="text-sm text-muted-foreground">
            Mes en curso · actividades de los últimos 30 días
          </p>
        </div>
        <Link
          href="/equipo/actividad"
          className="text-sm font-medium underline underline-offset-2"
        >
          Actividad por día →
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Persona</TableHead>
              <TableHead className="text-right">Casos del mes</TableHead>
              <TableHead className="text-right">Objetivo</TableHead>
              <TableHead className="text-right">Opps abiertas</TableHead>
              <TableHead className="text-right">Actividades 30d</TableHead>
              <TableHead className="text-right">Visitas 30d</TableHead>
              <TableHead className="text-right">KeepDays 30d</TableHead>
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
      <div className="space-y-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            Metas del comercial — mes en curso
          </h2>
          <p className="text-sm text-muted-foreground">
            Contactos (llamada + WhatsApp + visita + videollamada) ·
            videollamadas · KeepDays · casos del mes
            {isManager ? " — las metas se estipulan acá mismo" : ""}
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
        “Casos del mes” cuenta los casos nuevos (1ª etapa) de los doctores de los
        que cada persona es owner. Los objetivos por persona se cargan en la tabla
        goals (cuotas OKR: Juan 18 · Rocío 4→7 · nuevo/a 2→5).
      </p>
    </div>
  );
}

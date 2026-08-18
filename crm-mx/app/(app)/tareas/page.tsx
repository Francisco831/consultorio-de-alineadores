import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { TaskList } from "@/components/tasks/task-list";
import { buttonVariants } from "@/components/ui/button";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

export default async function TareasPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const { v = "mias" } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let query = supabase
    .from("tasks")
    .select("*")
    .order("status", { ascending: true })
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(300);
  if (v === "mias" && user) query = query.eq("assigned_to", user.id);

  const [{ data: tasksRaw }, { data: profilesRaw }, { data: doctorsRaw }] =
    await Promise.all([
      query,
      supabase.from("profiles").select("id, nombre"),
      // is_accredited viaja en el mapa que ya se consultaba: cero consultas extra,
      // y es lo que permite partir la lista en las dos áreas
      supabase.from("doctors").select("id, nombre, is_accredited"),
    ]);

  const tasks = (tasksRaw ?? []) as Task[];
  const profileName = Object.fromEntries(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );
  const doctores = (doctorsRaw ?? []) as {
    id: string;
    nombre: string;
    is_accredited: boolean;
  }[];
  const doctorName = Object.fromEntries(doctores.map((d) => [d.id, d.nombre]));
  const acreditado = Object.fromEntries(
    doctores.map((d) => [d.id, d.is_accredited])
  );

  // Las tres pilas. "Sin doctor" existe porque tasks.doctor_id es nullable
  // (0002:226): partir con un join dejaría esas tareas fuera de la pantalla.
  //
  // Por qué importa: "Llamar para que se acredite" y "Preguntar por próximos
  // pacientes" se veían idénticas —TaskList solo imprime el nombre del doctor— y
  // la automatización prospecto_sin_seguimiento genera las primeras sin parar.
  const porAcreditarse = tasks.filter(
    (t) => t.doctor_id && acreditado[t.doctor_id] === false
  );
  const acreditados = tasks.filter(
    (t) => t.doctor_id && acreditado[t.doctor_id] === true
  );
  const sinDoctor = tasks.filter(
    (t) => !t.doctor_id || acreditado[t.doctor_id] === undefined
  );

  const SECCIONES = [
    { titulo: "Por acreditarse", tareas: porAcreditarse },
    { titulo: "Acreditados", tareas: acreditados },
    { titulo: "Sin doctor", tareas: sinDoctor },
  ];

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Tareas</h1>
        <div className="flex gap-1">
          {[
            { key: "mias", label: "Mías" },
            { key: "equipo", label: "Equipo" },
          ].map((x) => (
            <Link
              key={x.key}
              href={x.key === "mias" ? "/tareas" : "/tareas?v=equipo"}
              className={cn(
                buttonVariants({
                  variant: v === x.key ? "secondary" : "ghost",
                  size: "sm",
                })
              )}
            >
              {x.label}
            </Link>
          ))}
        </div>
      </div>
      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {v === "mias"
            ? "No tenés tareas. Las automatizaciones y tus registros van a ir creando acá tu lista de trabajo."
            : "El equipo no tiene tareas registradas todavía."}
        </div>
      ) : (
        SECCIONES.map((sec) => (
          <section key={sec.titulo} className="space-y-2">
            <h2 className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {sec.titulo}
              <span className="tabular-nums font-normal text-muted-foreground/60">
                {sec.tareas.length}
              </span>
            </h2>
            {sec.tareas.length === 0 ? (
              // colapsada en una línea, no escondida: que se vea que el área existe
              // y hoy no tiene nada
              <p className="text-sm text-muted-foreground/60">Nada acá.</p>
            ) : (
              <TaskList
                tasks={sec.tareas}
                profileName={profileName}
                doctorName={doctorName}
                showDoctor
                emptyMessage=""
              />
            )}
          </section>
        ))
      )}
    </div>
  );
}

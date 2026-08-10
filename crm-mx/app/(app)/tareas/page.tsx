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
      supabase.from("doctors").select("id, nombre"),
    ]);

  const tasks = (tasksRaw ?? []) as Task[];
  const profileName = Object.fromEntries(
    ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [
      p.id,
      p.nombre,
    ])
  );
  const doctorName = Object.fromEntries(
    ((doctorsRaw ?? []) as { id: string; nombre: string }[]).map((d) => [
      d.id,
      d.nombre,
    ])
  );

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
      <TaskList
        tasks={tasks}
        profileName={profileName}
        doctorName={doctorName}
        showDoctor
        emptyMessage={
          v === "mias"
            ? "No tenés tareas. Las automatizaciones y tus registros van a ir creando acá tu lista de trabajo."
            : "El equipo no tiene tareas registradas todavía."
        }
      />
    </div>
  );
}

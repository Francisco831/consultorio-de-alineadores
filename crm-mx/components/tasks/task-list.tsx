"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, X, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { completeTask, cancelTask } from "@/lib/actions/tasks";
import { TASK_TYPE_LABELS, type Task } from "@/lib/types";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function TaskList({
  tasks,
  profileName,
  doctorName,
  emptyMessage,
  showDoctor,
}: {
  tasks: Task[];
  profileName: Record<string, string>;
  doctorName?: Record<string, string>;
  emptyMessage: string;
  showDoctor?: boolean;
}) {
  const [completing, setCompleting] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = tasks.filter((t) => t.status === "pendiente");
  const done = tasks.filter((t) => t.status !== "pendiente");
  // fecha de negocio en México, no UTC (toISOString corre el día a las 18:00 MX)
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
  }).format(new Date());

  if (tasks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  function submitComplete(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await completeTask(fd);
      if (res?.error) setError(res.error);
      else setCompleting(null);
    });
  }

  return (
    <div className="space-y-4">
      {open.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {open.map((t) => {
            const overdue = t.due_date != null && t.due_date < today;
            return (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t.title}</span>
                    <Badge variant="outline" className="font-normal">
                      {TASK_TYPE_LABELS[t.type]}
                    </Badge>
                    {showDoctor && t.doctor_id && doctorName?.[t.doctor_id] ? (
                      <Link
                        href={`/doctores/${t.doctor_id}`}
                        className="text-sm text-muted-foreground hover:underline"
                      >
                        {doctorName[t.doctor_id]}
                      </Link>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 flex items-center gap-1 text-xs",
                      overdue ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
                    )}
                  >
                    <CalendarClock className="h-3 w-3" />
                    {t.due_date
                      ? overdue
                        ? `Vencida — ${t.due_date}`
                        : t.due_date === today
                          ? "Hoy"
                          : t.due_date
                      : "Sin fecha"}
                    {t.assigned_to && profileName[t.assigned_to]
                      ? ` · ${profileName[t.assigned_to]}`
                      : null}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCompleting(t)}
                >
                  <Check data-icon="inline-start" />
                  Completar
                </Button>
                <form
                  action={(fd) => {
                    setError(null);
                    startTransition(async () => {
                      const res = await cancelTask(fd);
                      if (res?.error) setError(res.error);
                    });
                  }}
                >
                  <input type="hidden" name="task_id" value={t.id} />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="submit"
                    title="Cancelar tarea"
                  >
                    <X />
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nada pendiente. Excelente.
        </p>
      )}

      {error && completing === null ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {done.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Completadas y canceladas ({done.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {done.map((t) => (
              <li key={t.id} className="text-muted-foreground">
                <span
                  className={cn(
                    t.status === "completada" ? "line-through" : "line-through opacity-60"
                  )}
                >
                  {t.title}
                </span>
                {t.outcome ? ` — ${t.outcome}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* ---------- completar con outcome → próxima tarea en un solo flujo ---------- */}
      <Dialog
        open={completing !== null}
        onOpenChange={(o) => !o && setCompleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Completar tarea</DialogTitle>
            <DialogDescription>{completing?.title}</DialogDescription>
          </DialogHeader>
          <form action={submitComplete} className="space-y-3">
            <input type="hidden" name="task_id" value={completing?.id ?? ""} />
            <div className="space-y-1.5">
              <Label htmlFor="tl-outcome">Resultado</Label>
              <Input
                id="tl-outcome"
                name="outcome"
                placeholder="Paciente interesado, pide financiación…"
                autoFocus
              />
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Próximo paso (opcional)
              </p>
              <div className="space-y-3">
                <Input
                  name="next_title"
                  placeholder="Seguimiento el viernes…"
                  aria-label="Próxima tarea"
                />
                <div className="grid grid-cols-2 gap-3">
                  <select
                    name="next_type"
                    className={selectClass}
                    defaultValue="seguimiento"
                    aria-label="Tipo de próxima tarea"
                  >
                    {Object.entries(TASK_TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <Input name="next_due_date" type="date" aria-label="Fecha" />
                </div>
              </div>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Guardando…" : "Completar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

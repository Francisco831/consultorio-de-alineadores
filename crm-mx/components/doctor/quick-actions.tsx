"use client";

import { useState, useTransition } from "react";
import {
  MessageCircle,
  Phone,
  Plus,
  Pencil,
  ClipboardList,
  Target,
  FileSearch,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { logActivity } from "@/lib/actions/activities";
import { createTask } from "@/lib/actions/tasks";
import { createOpportunity } from "@/lib/actions/opportunities";
import { updateDoctorContact } from "@/lib/actions/doctors";
import { waLink, telLink, periskopeLink } from "@/lib/phone";
import { ACTIVITY_TYPE_LABELS, TASK_TYPE_LABELS, type Doctor } from "@/lib/types";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type DialogKind = "actividad" | "tarea" | "oportunidad" | "viabilidad" | "contacto" | null;

export function QuickActions({
  doctor,
  periskopeChatId,
}: {
  doctor: Doctor;
  periskopeChatId?: string | null;
}) {
  const [open, setOpenRaw] = useState<DialogKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // abrir/cerrar siempre limpia el error del diálogo anterior
  function setOpen(kind: DialogKind) {
    setError(null);
    setOpenRaw(kind);
  }

  // el chat del equipo vive en Periskope; wa.me queda de fallback sin chat conocido
  const wa =
    periskopeLink(periskopeChatId ?? null) ??
    waLink(doctor.whatsapp ?? doctor.phone);
  const tel = telLink(doctor.phone ?? doctor.whatsapp);

  function submit(
    action: (fd: FormData) => Promise<{ error?: string; ok?: boolean }>
  ) {
    return (fd: FormData) => {
      setError(null);
      startTransition(async () => {
        const res = await action(fd);
        if (res?.error) setError(res.error);
        else setOpen(null);
      });
    };
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {wa ? (
        <a
          href={wa}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <MessageCircle data-icon="inline-start" />
          WhatsApp
        </a>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen("contacto")}
          title="Sin teléfono cargado"
        >
          <MessageCircle data-icon="inline-start" />
          WhatsApp
        </Button>
      )}
      {tel ? (
        <a href={tel} className={buttonVariants({ variant: "outline", size: "sm" })}>
          <Phone data-icon="inline-start" />
          Llamar
        </a>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => setOpen("actividad")}>
        <Plus data-icon="inline-start" />
        Actividad
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen("tarea")}>
        <ClipboardList data-icon="inline-start" />
        Tarea
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen("oportunidad")}>
        <Target data-icon="inline-start" />
        Oportunidad
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen("viabilidad")}>
        <FileSearch data-icon="inline-start" />
        Viabilidad
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setOpen("contacto")}>
        <Pencil data-icon="inline-start" />
        Editar
      </Button>

      {/* ---------- registrar actividad ---------- */}
      <Dialog open={open === "actividad"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar actividad</DialogTitle>
            <DialogDescription>{doctor.nombre}</DialogDescription>
          </DialogHeader>
          <form action={submit(logActivity)} className="space-y-3">
            <input type="hidden" name="doctor_id" value={doctor.id} />
            <div className="space-y-1.5">
              <Label htmlFor="qa-type">Tipo</Label>
              <select id="qa-type" name="type" className={selectClass} defaultValue="whatsapp">
                {Object.entries(ACTIVITY_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qa-summary">Resumen</Label>
              <Textarea
                id="qa-summary"
                name="summary"
                placeholder="Qué pasó…"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qa-outcome">Resultado (opcional)</Label>
              <Input id="qa-outcome" name="outcome" placeholder="Interesada, pide precio…" />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Guardando…" : "Guardar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- nueva tarea ---------- */}
      <Dialog open={open === "tarea"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nueva tarea</DialogTitle>
            <DialogDescription>{doctor.nombre}</DialogDescription>
          </DialogHeader>
          <form action={submit(createTask)} className="space-y-3">
            <input type="hidden" name="doctor_id" value={doctor.id} />
            <div className="space-y-1.5">
              <Label htmlFor="qa-task-title">Qué hay que hacer</Label>
              <Input
                id="qa-task-title"
                name="title"
                required
                placeholder="Seguimiento del paciente García…"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="qa-task-type">Tipo</Label>
                <select id="qa-task-type" name="type" className={selectClass} defaultValue="whatsapp">
                  {Object.entries(TASK_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qa-task-due">Fecha</Label>
                <Input id="qa-task-due" name="due_date" type="date" />
              </div>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Creando…" : "Crear tarea"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- nueva oportunidad ---------- */}
      <Dialog
        open={open === "oportunidad" || open === "viabilidad"}
        onOpenChange={(o) => !o && setOpen(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {open === "viabilidad" ? "Nueva viabilidad" : "Nueva oportunidad"}
            </DialogTitle>
            <DialogDescription>
              {open === "viabilidad"
                ? `Un posible caso que ${doctor.nombre} está evaluando si entra`
                : `Un paciente potencial de ${doctor.nombre}`}
            </DialogDescription>
          </DialogHeader>
          <form action={submit(createOpportunity)} className="space-y-3">
            <input type="hidden" name="doctor_id" value={doctor.id} />
            <input
              type="hidden"
              name="stage"
              value={open === "viabilidad" ? "viabilidad" : "paciente_potencial"}
            />
            <div className="space-y-1.5">
              <Label htmlFor="qa-opp-patient">Paciente</Label>
              <Input id="qa-opp-patient" name="patient_name" placeholder="Nombre del paciente" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="qa-opp-amount">Monto MXN (opcional)</Label>
                <Input
                  id="qa-opp-amount"
                  name="amount_mxn"
                  type="number"
                  min="0"
                  step="100"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qa-opp-close">Cierre estimado</Label>
                <Input id="qa-opp-close" name="expected_close_date" type="date" />
              </div>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending
                  ? "Creando…"
                  : open === "viabilidad"
                    ? "Crear viabilidad"
                    : "Crear oportunidad"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- editar contacto ---------- */}
      <Dialog open={open === "contacto"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Datos de contacto</DialogTitle>
            <DialogDescription>
              {doctor.phone || doctor.whatsapp
                ? doctor.nombre
                : `${doctor.nombre} no tiene teléfono cargado — este dato vale oro.`}
            </DialogDescription>
          </DialogHeader>
          <form action={submit(updateDoctorContact)} className="space-y-3">
            <input type="hidden" name="id" value={doctor.id} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="qa-c-phone">Teléfono</Label>
                <Input
                  id="qa-c-phone"
                  name="phone"
                  defaultValue={doctor.phone ?? ""}
                  placeholder="55 1234 5678"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qa-c-wa">WhatsApp</Label>
                <Input
                  id="qa-c-wa"
                  name="whatsapp"
                  defaultValue={doctor.whatsapp ?? ""}
                  placeholder="igual al teléfono si es el mismo"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qa-c-email">Email</Label>
              <Input
                id="qa-c-email"
                name="email"
                type="email"
                defaultValue={doctor.email ?? ""}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="qa-c-city">Ciudad</Label>
                <Input
                  id="qa-c-city"
                  name="city"
                  defaultValue={doctor.city ?? ""}
                  placeholder="CDMX, Monterrey…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qa-c-zona">Zona</Label>
                <select
                  id="qa-c-zona"
                  name="zona"
                  className={selectClass}
                  defaultValue={doctor.zona ?? ""}
                >
                  <option value="">Sin zona</option>
                  <option value="CDMX">CDMX</option>
                  <option value="Norte">Norte</option>
                  <option value="Sur">Sur</option>
                  <option value="Foráneos">Foráneos</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qa-c-clinic">Clínica</Label>
              <Input
                id="qa-c-clinic"
                name="clinic_name"
                defaultValue={doctor.clinic_name ?? ""}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Guardando…" : "Guardar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
  MoveRight,
  BadgeCheck,
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
import { moveAcquisitionStage, acreditarDoctor } from "@/lib/actions/journey";
import { updateDoctorContact } from "@/lib/actions/doctors";
import { waLink, telLink, periskopeLink } from "@/lib/phone";
import {
  ACTIVITY_TYPE_LABELS,
  TASK_TYPE_LABELS,
  ACQ_STAGE_LABELS,
  type AcqStage,
  type Doctor,
} from "@/lib/types";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type DialogKind =
  | "actividad"
  | "tarea"
  | "oportunidad"
  | "viabilidad"
  | "contacto"
  | "etapa"
  | "acreditar"
  | null;

// El área "Por acreditarse" mueve al doctor con estas etapas. 'acreditado' NO está:
// cruzar de área es una acción con nombre propio y con recibo, no un ítem más de un
// select (ver el botón Acreditar). 'no_interesado' sí, porque descartar es parte del
// trabajo de este lado.
const ETAPAS_ADQUISICION = (
  Object.keys(ACQ_STAGE_LABELS) as AcqStage[]
).filter((e) => e !== "acreditado");

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

  // moveAcquisitionStage toma (id, etapa), no un FormData: va con su propio submit.
  function moverEtapa(fd: FormData) {
    setError(null);
    const etapa = String(fd.get("acquisition_stage") ?? "") as AcqStage;
    if (!etapa) return;
    startTransition(async () => {
      const res = await moveAcquisitionStage(doctor.id, etapa);
      if (res?.error) setError(res.error);
      else setOpen(null);
    });
  }

  function acreditar(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await acreditarDoctor(doctor.id, String(fd.get("nota") ?? ""));
      // el aviso es el caso raro en que el doctor YA cruzó pero la nota no se
      // guardó: se muestra igual que un error y el diálogo queda abierto, porque
      // cerrarlo diciendo "listo" sería mentir a medias
      const problema = res.error ?? ("aviso" in res ? res.aviso : null);
      if (problema) setError(problema);
      else setOpen(null);
    });
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
      {/* La acción propia del área "Por acreditarse", que hasta ahora vivía solo en
          el arrastre del kanban: desde la ficha de un prospecto no había forma de
          moverlo de etapa. */}
      {!doctor.is_accredited ? (
        <>
          <Button size="sm" onClick={() => setOpen("acreditar")}>
            <BadgeCheck data-icon="inline-start" />
            Acreditar
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOpen("etapa")}>
            <MoveRight data-icon="inline-start" />
            Mover etapa
          </Button>
        </>
      ) : null}
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
          {/* No se bloquea: un doctor importante puede traer un paciente antes de
              acreditarse. Pero se dice, porque es la señal más caliente del área
              "Por acreditarse" y no tiene que pasar desapercibida. */}
          {!doctor.is_accredited ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {doctor.nombre} todavía no está acreditado. Se puede cargar igual —
              tener un paciente esperando es motivo para acreditarlo cuanto antes—
              pero el caso no va a poder ingresar hasta que la acreditación esté hecha.
            </p>
          ) : null}
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

      {/* ---------- acreditar: el cruce de área, con recibo ---------- */}
      <Dialog open={open === "acreditar"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acreditar a {doctor.nombre}</DialogTitle>
            <DialogDescription>
              Pasa al área de acreditados y arranca el pipeline de activación.
            </DialogDescription>
          </DialogHeader>
          <form action={acreditar} className="space-y-3">
            <ul className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <li>· Queda acreditado con fecha de hoy.</li>
              <li>· Se cierran las tareas de captación que sigan abiertas.</li>
              <li>· Queda el hito en su historial.</li>
            </ul>
            <div className="space-y-1.5">
              <Label htmlFor="qa-acr-nota">Nota (opcional)</Label>
              <Textarea
                id="qa-acr-nota"
                name="nota"
                rows={2}
                placeholder="Cómo se cerró, qué acordaron, qué sigue…"
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Acreditando…" : "Acreditar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- mover de etapa (área "Por acreditarse") ---------- */}
      <Dialog open={open === "etapa"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mover de etapa</DialogTitle>
            <DialogDescription>
              {doctor.nombre} · pipeline de acreditación
            </DialogDescription>
          </DialogHeader>
          <form action={moverEtapa} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="qa-acq-stage">Etapa</Label>
              <select
                id="qa-acq-stage"
                name="acquisition_stage"
                className={selectClass}
                defaultValue={doctor.acquisition_stage ?? "identificado"}
              >
                {ETAPAS_ADQUISICION.map((e) => (
                  <option key={e} value={e}>
                    {ACQ_STAGE_LABELS[e]}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Acreditarlo no se hace desde acá: es el botón Acreditar, que además
              cierra las tareas de captación y deja el hito en el historial.
            </p>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Moviendo…" : "Mover"}
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

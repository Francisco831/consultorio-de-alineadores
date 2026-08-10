"use client";

/**
 * Kanban de DOCTORES (no de oportunidades) para los dos pipelines del journey:
 *  - adquisicion: universo A (no acreditados) → objetivo: que se acrediten.
 *    Soltar en "Acreditado" dispara la Conversión 1 (fecha + pasa a activación).
 *  - activacion: universo B sin primer caso → objetivo: primer caso pagado.
 *    Soltar en "1er caso pagado" dispara la Conversión 2 (lifecycle=activado).
 * El doctor NUNCA se duplica: es el mismo registro avanzando de etapa.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Badge } from "@/components/ui/badge";
import {
  moveAcquisitionStage,
  moveActivationStage,
} from "@/lib/actions/journey";
import { daysSince } from "@/lib/format";
import {
  ACQ_STAGE_LABELS,
  ACT_STAGE_LABELS,
  SOURCE_LABELS,
  type AcqStage,
  type ActStage,
  type AttributionSource,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface JourneyDoctor {
  id: string;
  nombre: string;
  city: string | null;
  source: AttributionSource | null;
  owner_id: string | null;
  acquisition_stage: AcqStage | null;
  activation_stage: ActStage | null;
  interest_level: number | null;
  estimated_cases_month: number | null;
  priority_score: number | null;
  last_contact_at: string | null;
  accredited_at: string | null;
  created_at: string;
  is_demo: boolean;
}

const ACQ_COLUMNS: AcqStage[] = [
  "identificado",
  "contacto_intentado",
  "contactado",
  "calificado",
  "reunion_agendada",
  "reunion_realizada",
  "interes_acreditacion",
  "acreditacion_agendada",
  "acreditado",
  "no_interesado",
];

const ACT_COLUMNS: ActStage[] = [
  "acreditado",
  "contactado_post",
  "paciente_potencial",
  "documentacion",
  "caso_ingresado",
  "planificacion",
  "presentado",
  "primer_caso_pagado",
];

export function JourneyBoard({
  mode,
  doctors,
  ownerNames,
  columnCounts,
  perColumn = 30,
}: {
  mode: "adquisicion" | "activacion";
  doctors: JourneyDoctor[];
  ownerNames: Record<string, string>;
  /** totales reales por etapa (el board puede recibir solo el top por prioridad) */
  columnCounts?: Record<string, number>;
  perColumn?: number;
}) {
  const [docs, setDocs] = useState(doctors);
  const [, startTransition] = useTransition();

  // la revalidación del server refresca las props → sincronizar la copia local
  const [prevDoctors, setPrevDoctors] = useState(doctors);
  if (prevDoctors !== doctors) {
    setPrevDoctors(doctors);
    setDocs(doctors);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const columns = mode === "adquisicion" ? ACQ_COLUMNS : ACT_COLUMNS;
  const labels: Record<string, string> =
    mode === "adquisicion" ? ACQ_STAGE_LABELS : ACT_STAGE_LABELS;
  const stageOf = (d: JourneyDoctor) =>
    mode === "adquisicion" ? d.acquisition_stage : d.activation_stage;

  function applyStage(doctorId: string, stage: string) {
    const prev = docs;
    setDocs((cur) =>
      cur.map((d) =>
        d.id === doctorId
          ? mode === "adquisicion"
            ? { ...d, acquisition_stage: stage as AcqStage }
            : { ...d, activation_stage: stage as ActStage }
          : d
      )
    );
    startTransition(async () => {
      const res =
        mode === "adquisicion"
          ? await moveAcquisitionStage(doctorId, stage as AcqStage)
          : await moveActivationStage(doctorId, stage as ActStage);
      if (res?.error) {
        setDocs(prev);
        toast.error(`No se pudo mover al doctor: ${res.error}`);
      } else if (mode === "adquisicion" && stage === "acreditado") {
        toast.success("🎓 Doctor acreditado — pasa al pipeline de activación");
      } else if (mode === "activacion" && stage === "primer_caso_pagado") {
        toast.success("🎉 Primer caso pagado — doctor ACTIVADO");
      }
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const target = event.over ? String(event.over.id) : null;
    if (!target) return;
    const doc = docs.find((d) => d.id === String(event.active.id));
    if (!doc || stageOf(doc) === target) return;
    applyStage(doc.id, target);
  }

  return (
    <div className="relative">
      <Toaster position="bottom-right" />
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((stage) => {
            const all = docs.filter((d) => stageOf(d) === stage);
            const cards = all.slice(0, perColumn);
            const total = columnCounts?.[stage] ?? all.length;
            const terminal =
              stage === "acreditado" && mode === "adquisicion"
                ? "win"
                : stage === "primer_caso_pagado"
                  ? "win"
                  : stage === "no_interesado"
                    ? "lost"
                    : null;
            return (
              <JourneyColumn
                key={stage}
                stage={stage}
                label={labels[stage]}
                count={total}
                terminal={terminal}
              >
                {cards.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                    Nadie en esta etapa.
                  </p>
                ) : (
                  <>
                    {cards.map((d) => (
                      <DoctorCard
                        key={d.id}
                        doctor={d}
                        mode={mode}
                        ownerName={
                          d.owner_id ? ownerNames[d.owner_id] : undefined
                        }
                      />
                    ))}
                    {total > cards.length ? (
                      <Link
                        href={
                          mode === "adquisicion"
                            ? "/doctores?f=prospectos&sort=prioridad"
                            : "/doctores?f=activacion&sort=prioridad"
                        }
                        className="rounded-lg border border-dashed p-2.5 text-center text-xs text-muted-foreground hover:bg-muted/60"
                      >
                        +{total - cards.length} más (por prioridad) — ver todos
                      </Link>
                    ) : null}
                  </>
                )}
              </JourneyColumn>
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}

function JourneyColumn({
  stage,
  label,
  count,
  terminal,
  children,
}: {
  stage: string;
  label: string;
  count: number;
  terminal: "win" | "lost" | null;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div className="flex w-64 shrink-0 flex-col">
      <div className="flex items-baseline gap-1.5 px-1 pb-2">
        <h2
          className={cn(
            "text-[13px] font-medium",
            terminal === "win" && "text-emerald-700 dark:text-emerald-400",
            terminal === "lost" && "text-muted-foreground"
          )}
        >
          {label}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-32 flex-1 flex-col gap-2 rounded-lg bg-muted/40 p-2 transition-colors",
          terminal === "win" && "bg-emerald-50/60 dark:bg-emerald-950/30",
          isOver && "bg-muted ring-2 ring-ring/40"
        )}
      >
        {children}
      </div>
    </div>
  );
}

function DoctorCard({
  doctor,
  mode,
  ownerName,
}: {
  doctor: JourneyDoctor;
  mode: "adquisicion" | "activacion";
  ownerName?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: doctor.id });

  const contactDays = daysSince(doctor.last_contact_at);
  const accreditedDays = daysSince(doctor.accredited_at ?? doctor.created_at);
  // en activación el reloj que importa es "hace cuánto se acreditó sin activar"
  const aging =
    mode === "activacion"
      ? accreditedDays != null && accreditedDays > 30
      : contactDays != null && contactDays > 14;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "cursor-grab rounded-lg border bg-background p-3 shadow-xs",
        isDragging && "z-10 opacity-90 shadow-md"
      )}
      {...listeners}
      {...attributes}
    >
      <Link
        href={`/doctores/${doctor.id}`}
        className="block truncate text-sm font-medium hover:underline"
      >
        {doctor.nombre}
      </Link>
      <p className="truncate text-xs text-muted-foreground">
        {[
          doctor.city,
          doctor.source ? SOURCE_LABELS[doctor.source] : null,
          mode === "adquisicion" && doctor.estimated_cases_month
            ? `~${Math.round(doctor.estimated_cases_month)} casos/mes`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—"}
      </p>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className={cn("tabular-nums", aging && "font-medium text-orange-600 dark:text-orange-400")}>
          {mode === "activacion"
            ? accreditedDays == null
              ? "—"
              : `acreditado hace ${accreditedDays} d`
            : contactDays == null
              ? "sin contacto"
              : `contacto hace ${contactDays} d`}
        </span>
        <span className="flex items-center gap-1">
          {mode === "adquisicion" && doctor.interest_level ? (
            <span className="tabular-nums">interés {doctor.interest_level}/5</span>
          ) : null}
          {ownerName ? <span className="truncate">{ownerName}</span> : null}
          {doctor.is_demo ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
              demo
            </Badge>
          ) : null}
        </span>
      </div>
    </div>
  );
}

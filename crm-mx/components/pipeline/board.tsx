"use client";

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
import { MoreHorizontal, Trophy, XCircle, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";
import {
  markLost,
  moveOpportunityStage,
  updateOpportunityMeta,
} from "@/lib/actions/opportunities";
import { daysSince, formatMXN } from "@/lib/format";
import { OPP_STAGE_LABELS, type ForecastCat, type OppStage } from "@/lib/types";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const OPEN_STAGES: OppStage[] = [
  "viabilidad",
  "paciente_potencial",
  "documentacion",
  "caso_ingresado",
  "planificacion",
  "presentada",
  "decision",
  "compromiso",
];

// misma lista que lib/actions/opportunities.ts
const LOST_REASONS = [
  "Precio",
  "Competencia",
  "Paciente desistió",
  "Financiación",
  "Clínico",
  "Otro",
];

const FORECAST_LABELS: Record<Exclude<ForecastCat, "closed">, string> = {
  pipeline: "Pipeline",
  best_case: "Best case",
  commit: "Commit",
  omitted: "Omitida",
};

export interface PipelineOpp {
  id: string;
  doctor_id: string;
  patient_name: string | null;
  stage: OppStage;
  stage_entered_at: string;
  amount_mxn: number | null;
  probability: number | null;
  forecast_category: ForecastCat;
  expected_close_date: string | null;
  owner_id: string | null;
  is_demo: boolean;
  doctor: { id: string; nombre: string; is_accredited?: boolean } | null;
}

export function PipelineBoard({
  opportunities,
  ownerNames,
}: {
  opportunities: PipelineOpp[];
  ownerNames: Record<string, string>;
}) {
  const [opps, setOpps] = useState(opportunities);
  const [losing, setLosing] = useState<PipelineOpp | null>(null);
  const [editing, setEditing] = useState<PipelineOpp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // la revalidación del server refresca las props → sincronizar la copia local
  // (ajuste durante el render, patrón recomendado por React)
  const [prevOpportunities, setPrevOpportunities] = useState(opportunities);
  if (prevOpportunities !== opportunities) {
    setPrevOpportunities(opportunities);
    setOpps(opportunities);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  function applyStage(oppId: string, stage: OppStage) {
    const prev = opps;
    setOpps((cur) =>
      stage === "ganada" || stage === "perdida"
        ? cur.filter((o) => o.id !== oppId)
        : cur.map((o) =>
            o.id === oppId
              ? { ...o, stage, stage_entered_at: new Date().toISOString() }
              : o
          )
    );
    startTransition(async () => {
      const res = await moveOpportunityStage(oppId, stage);
      if (res?.error) {
        setOpps(prev);
        toast.error(`No se pudo mover la oportunidad: ${res.error}`);
      } else if (stage === "ganada") {
        toast.success("Oportunidad ganada");
      }
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const target = event.over ? (String(event.over.id) as OppStage) : null;
    if (!target) return;
    const opp = opps.find((o) => o.id === String(event.active.id));
    if (!opp || opp.stage === target) return;
    applyStage(opp.id, target);
  }

  function submitLost(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await markLost(fd);
      if (res?.error) {
        setError(res.error);
      } else {
        const id = String(fd.get("opportunity_id"));
        setOpps((cur) => cur.filter((o) => o.id !== id));
        setLosing(null);
      }
    });
  }

  function submitMeta(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await updateOpportunityMeta(fd);
      if (res?.error) setError(res.error);
      else setEditing(null);
    });
  }

  return (
    <div className="relative">
      <Toaster position="bottom-right" />
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {OPEN_STAGES.map((stage) => {
            const cards = opps.filter((o) => o.stage === stage);
            const sum = cards.reduce((acc, o) => acc + (o.amount_mxn ?? 0), 0);
            return (
              <StageColumn key={stage} stage={stage} count={cards.length} sum={sum}>
                {cards.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                    Sin oportunidades acá. Arrastrá una tarjeta o creá una desde
                    la ficha del doctor.
                  </p>
                ) : (
                  cards.map((o) => (
                    <OppCard
                      key={o.id}
                      opp={o}
                      ownerName={o.owner_id ? ownerNames[o.owner_id] : undefined}
                      onWon={() => applyStage(o.id, "ganada")}
                      onLost={() => {
                        setError(null);
                        setLosing(o);
                      }}
                      onEdit={() => {
                        setError(null);
                        setEditing(o);
                      }}
                    />
                  ))
                )}
              </StageColumn>
            );
          })}
        </div>
      </DndContext>

      {/* ---------- marcar perdida ---------- */}
      <Dialog open={losing !== null} onOpenChange={(o) => !o && setLosing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marcar como perdida</DialogTitle>
            <DialogDescription>
              {losing?.doctor?.nombre}
              {losing?.patient_name ? ` — ${losing.patient_name}` : ""}
            </DialogDescription>
          </DialogHeader>
          <form action={submitLost} className="space-y-3">
            <input
              type="hidden"
              name="opportunity_id"
              value={losing?.id ?? ""}
            />
            <div className="space-y-1.5">
              <Label htmlFor="pb-lost-reason">Motivo</Label>
              <select
                id="pb-lost-reason"
                name="lost_reason"
                className={selectClass}
                defaultValue="Precio"
              >
                {LOST_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pb-lost-note">Nota (opcional)</Label>
              <Input
                id="pb-lost-note"
                name="lost_note"
                placeholder="Se fue con otra marca, quizás vuelva en 6 meses…"
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Guardando…" : "Marcar perdida"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------- editar forecast / monto ---------- */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar oportunidad</DialogTitle>
            <DialogDescription>
              {editing?.doctor?.nombre}
              {editing?.patient_name ? ` — ${editing.patient_name}` : ""}
            </DialogDescription>
          </DialogHeader>
          <form action={submitMeta} className="space-y-3" key={editing?.id}>
            <input
              type="hidden"
              name="opportunity_id"
              value={editing?.id ?? ""}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pb-prob">Probabilidad %</Label>
                <Input
                  id="pb-prob"
                  name="probability"
                  type="number"
                  min="0"
                  max="100"
                  step="5"
                  defaultValue={editing?.probability ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pb-forecast">Forecast</Label>
                <select
                  id="pb-forecast"
                  name="forecast_category"
                  className={selectClass}
                  defaultValue={editing?.forecast_category ?? "pipeline"}
                >
                  {Object.entries(FORECAST_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pb-amount">Monto MXN</Label>
                <Input
                  id="pb-amount"
                  name="amount_mxn"
                  type="number"
                  min="0"
                  step="100"
                  defaultValue={editing?.amount_mxn ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pb-close">Cierre estimado</Label>
                <Input
                  id="pb-close"
                  name="expected_close_date"
                  type="date"
                  defaultValue={editing?.expected_close_date ?? ""}
                />
              </div>
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

function StageColumn({
  stage,
  count,
  sum,
  children,
}: {
  stage: OppStage;
  count: number;
  sum: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div className="flex w-72 shrink-0 flex-col">
      <div className="flex items-baseline justify-between px-1 pb-2">
        <div className="flex items-baseline gap-1.5">
          <h2 className="text-[13px] font-medium">{OPP_STAGE_LABELS[stage]}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        </div>
        {sum > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatMXN(sum)}
          </span>
        ) : null}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-32 flex-1 flex-col gap-2 rounded-lg bg-muted/40 p-2 transition-colors",
          isOver && "bg-muted ring-2 ring-ring/40"
        )}
      >
        {children}
      </div>
    </div>
  );
}

function OppCard({
  opp,
  ownerName,
  onWon,
  onLost,
  onEdit,
}: {
  opp: PipelineOpp;
  ownerName?: string;
  onWon: () => void;
  onLost: () => void;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: opp.id });
  const days = daysSince(opp.stage_entered_at) ?? 0;
  const stalled = days > 10;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "rounded-lg border bg-background p-3 shadow-xs",
        isDragging && "z-10 opacity-90 shadow-md"
      )}
      {...listeners}
      {...attributes}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {opp.doctor ? (
            <Link
              href={`/doctores/${opp.doctor.id}`}
              className="block truncate text-sm font-medium hover:underline"
            >
              {opp.doctor.nombre}
              {opp.doctor.is_accredited === false ? (
                <span
                  className="ml-1.5 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1 py-px align-middle text-[9px] font-semibold uppercase tracking-wide text-amber-300"
                  title="Este doctor todavía no está acreditado: el caso no puede ingresar hasta que lo esté"
                >
                  sin acreditar
                </span>
              ) : null}
            </Link>
          ) : (
            <span className="text-sm font-medium text-muted-foreground">
              Doctor sin datos
            </span>
          )}
          {opp.patient_name ? (
            <p className="truncate text-xs text-muted-foreground">
              {opp.patient_name}
            </p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Acciones"
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onWon}>
              <Trophy className="mr-2 h-4 w-4" />
              Ganada
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onLost}>
              <XCircle className="mr-2 h-4 w-4" />
              Perdida
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 h-4 w-4" />
              Editar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="tabular-nums font-medium">
          {formatMXN(opp.amount_mxn)}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {opp.probability ?? 0}%
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span
          className={cn(
            "tabular-nums",
            stalled && "font-medium text-red-600 dark:text-red-400"
          )}
        >
          {days} {days === 1 ? "día" : "días"} en etapa
        </span>
        <span className="flex items-center gap-1">
          {ownerName ? <span className="truncate">{ownerName}</span> : null}
          {opp.is_demo ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
              demo
            </Badge>
          ) : null}
        </span>
      </div>
    </div>
  );
}

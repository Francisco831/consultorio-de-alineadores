"use client";

// Card de UNA recomendación AI con el contrato HITL completo (P34):
// evidencia primero, inferencias marcadas, y la decisión siempre humana —
// Aceptar ejecuta el draft vía server action; Descartar exige motivo
// (insumo directo de la blacklist futura).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { acceptRecommendation, dismissRecommendation } from "@/lib/actions/ai";
import { AgentBadge } from "@/components/ai/agent-badge";
import { formatDate, relativeDays } from "@/lib/format";
import { TASK_TYPE_LABELS } from "@/lib/types";
import type {
  AiRecommendationRow,
  RecommendationChannel,
  RecommendationPayload,
  RecommendationStatus,
} from "@/lib/ai/types";

const CHANNEL_LABELS: Record<RecommendationChannel, string> = {
  whatsapp: "WhatsApp",
  call: "Llamada",
  video: "Videollamada",
  visit: "Visita",
  clinical: "Revisión clínica",
  task: "Tarea",
};

const STATUS_LABELS: Record<RecommendationStatus, string> = {
  propuesta: "Propuesta",
  aceptada: "Aceptada",
  descartada: "Descartada",
  ejecutada: "Ejecutada",
  expirada: "Expirada",
};

// qué se va a crear al aceptar (el draft ejecutable del payload)
function payloadPreview(p: RecommendationPayload): string | null {
  switch (p.kind) {
    case "task":
      return `Al aceptar se crea la tarea: “${p.title}” (${TASK_TYPE_LABELS[p.type]}${
        p.due_date ? `, vence ${formatDate(p.due_date)}` : ", sin fecha"
      })`;
    case "activity":
      return `Al aceptar se registra la actividad (${p.type}): ${p.summary}`;
    case "profile_update":
      return `Al aceptar se actualiza el perfil AI del doctor (${
        Object.keys(p.fields).length
      } campo(s): ${Object.keys(p.fields).join(", ")})`;
    default:
      return null;
  }
}

export function RecommendationCard({ rec }: { rec: AiRecommendationRow }) {
  const router = useRouter();
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const decided = rec.status !== "propuesta";
  const preview = !decided && rec.payload ? payloadPreview(rec.payload) : null;

  function submitAccept(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await acceptRecommendation(fd);
      if (res?.error) {
        setError(res.error);
        toast.error(res.error);
      } else {
        toast.success("Recomendación aceptada");
        router.refresh();
      }
    });
  }

  function submitDismiss(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await dismissRecommendation(fd);
      if (res?.error) {
        setError(res.error);
      } else {
        setDismissing(false);
        toast.success("Recomendación descartada");
        router.refresh();
      }
    });
  }

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(rec.suggested_message ?? "");
      setCopied(true);
      toast.success("Mensaje copiado");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("No se pudo copiar el mensaje");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {/* ---------- header: agente + estado + scores ---------- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <AgentBadge agent={rec.agent} />
          {decided ? (
            <Badge
              variant="outline"
              className="h-4.5 border-transparent bg-muted px-1.5 text-[10px] font-normal text-muted-foreground"
            >
              {STATUS_LABELS[rec.status]}
              {rec.decided_at ? ` · ${relativeDays(rec.decided_at)}` : ""}
            </Badge>
          ) : null}
        </div>
        {rec.confidence != null || rec.commercial_priority != null ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {rec.confidence != null ? `Confianza ${rec.confidence}` : null}
            {rec.confidence != null && rec.commercial_priority != null
              ? " · "
              : null}
            {rec.commercial_priority != null
              ? `Prioridad ${rec.commercial_priority}`
              : null}
          </span>
        ) : null}
      </div>

      {/* ---------- la acción recomendada ---------- */}
      <div>
        <p className="text-sm font-medium">{rec.recommended_action}</p>
        {rec.objective ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Objetivo: {rec.objective}
          </p>
        ) : null}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {rec.channel ? CHANNEL_LABELS[rec.channel] : "Sin canal"}
          {" · "}
          {rec.recommended_date
            ? formatDate(rec.recommended_date)
            : "sin fecha sugerida"}
        </p>
      </div>

      {/* ---------- por qué (inferencias, marcadas como tales) ---------- */}
      {rec.why.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Por qué
          </p>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {rec.why.map((w, i) => (
              <li key={i}>
                • {w}{" "}
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  · inferencia
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---------- evidencia (FACTS con campo y valor) ---------- */}
      {rec.evidence.length > 0 ? (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Datos
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {rec.evidence.map((e, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px]"
              >
                <span className="font-medium text-muted-foreground">
                  {e.field}:
                </span>
                <span className="tabular-nums">{e.value}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* ---------- borrador de mensaje (copiable, nunca se envía solo) ---------- */}
      {rec.suggested_message ? (
        <div className="rounded-lg border bg-muted/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="whitespace-pre-wrap text-sm">{rec.suggested_message}</p>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={copyMessage}
              title="Copiar mensaje"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Borrador — no se envía solo. Copialo y mandalo desde WhatsApp.
          </p>
        </div>
      ) : null}

      {/* ---------- qué pasa al aceptar + decisión ---------- */}
      {preview ? (
        <p className="text-xs text-muted-foreground">{preview}</p>
      ) : null}

      {decided ? (
        rec.dismiss_reason ? (
          <p className="text-xs text-muted-foreground">
            Motivo del descarte: {rec.dismiss_reason}
          </p>
        ) : null
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <form action={submitAccept}>
            <input type="hidden" name="recommendation_id" value={rec.id} />
            <Button size="sm" type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Aceptar"}
            </Button>
          </form>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDismissing(true)}
            disabled={pending}
          >
            Descartar
          </Button>
        </div>
      )}
      {error && !dismissing ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {/* ---------- descartar con motivo obligatorio ---------- */}
      <Dialog open={dismissing} onOpenChange={(o) => !o && setDismissing(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Descartar recomendación</DialogTitle>
            <DialogDescription>
              Contanos por qué no aplica — con eso los agentes aprenden a no
              proponerla de nuevo.
            </DialogDescription>
          </DialogHeader>
          <form action={submitDismiss} className="space-y-3">
            <input type="hidden" name="recommendation_id" value={rec.id} />
            <div className="space-y-1.5">
              <Label htmlFor={`rc-reason-${rec.id}`}>Motivo</Label>
              <Textarea
                id={`rc-reason-${rec.id}`}
                name="dismiss_reason"
                required
                rows={2}
                placeholder="Ya lo contacté ayer, el dato está viejo…"
                autoFocus
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Descartando…" : "Descartar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

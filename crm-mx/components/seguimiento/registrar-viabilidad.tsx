"use client";

// Cargar a mano en qué quedó una viabilidad. Vive en /seguimiento porque ahí es
// donde se ve la cola esperando; el ciclo no lo trae ningún sync (el equipo
// clínico contesta por WhatsApp), así que este formulario ES la fuente del dato.

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { registrarViabilidad } from "@/lib/actions/viabilidad";
import { VIABILITY_STATUS_LABELS, type ViabilityStatus } from "@/lib/types";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function RegistrarViabilidad({
  opportunityId,
  paciente,
  estadoActual,
}: {
  opportunityId: string;
  paciente: string | null;
  estadoActual: ViabilityStatus | null;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(fd: FormData) {
    setError(null);
    setGuardado(false);
    fd.set("opportunity_id", opportunityId);
    startTransition(async () => {
      const res = await registrarViabilidad(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      // el diálogo queda un segundo con el visto puesto: si se cerrara de golpe
      // la fila desaparece de la lista y no se entiende si guardó o falló
      setGuardado(true);
      setTimeout(() => {
        setOpen(false);
        setGuardado(false);
      }, 1200);
    });
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setGuardado(false);
          setOpen(true);
        }}
      >
        Registrar respuesta
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Registrar respuesta</DialogTitle>
            <DialogDescription>
              {paciente ? `Paciente ${paciente}. ` : ""}Con
              &laquo;Respondida&raquo; o &laquo;Sin respuesta&raquo; el ciclo se
              cierra y sale de la lista de espera.
            </DialogDescription>
          </DialogHeader>
          <form action={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rv-status">¿En qué quedó? *</Label>
              <select
                id="rv-status"
                name="viability_status"
                className={selectClass}
                defaultValue={estadoActual ?? ""}
                required
              >
                <option value="" disabled>
                  Elegí un estado…
                </option>
                {(
                  Object.entries(VIABILITY_STATUS_LABELS) as [
                    ViabilityStatus,
                    string,
                  ][]
                ).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rv-result">Resultado</Label>
              <Textarea
                id="rv-result"
                name="viability_result"
                rows={3}
                placeholder="Qué contestó el equipo clínico, qué se le dijo a la doctora…"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rv-follow">Volver a mirar el</Label>
              <Input
                id="rv-follow"
                name="viability_follow_up_date"
                type="date"
              />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <DialogFooter className="items-center gap-2 sm:justify-start">
              <Button type="submit" size="sm" disabled={pending || guardado}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar"}
              </Button>
              {guardado ? (
                <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                  <Check className="h-4 w-4" /> Guardado
                </span>
              ) : null}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

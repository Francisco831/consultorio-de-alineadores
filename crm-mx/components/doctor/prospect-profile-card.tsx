"use client";

/**
 * Perfil comercial del PROSPECTO (universo A): la info que sí existe antes
 * de acreditarse y que alimenta su priority score. Solo se muestra en
 * doctores no acreditados.
 */
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateProspectProfile } from "@/lib/actions/journey";
import type { Doctor } from "@/lib/types";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function ProspectProfileCard({ doctor }: { doctor: Doctor }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(fd: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updateProspectProfile(fd);
      if (res?.error) setError(res.error);
      else setSaved(true);
    });
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Perfil de prospecto
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Esta info mueve su prioridad: interés, potencial estimado y si ya usa
        alineadores.
      </p>
      <form action={submit} className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <input type="hidden" name="id" value={doctor.id} />
        <div className="space-y-1">
          <Label htmlFor="pp-specialty" className="text-xs">
            Especialidad
          </Label>
          <Input
            id="pp-specialty"
            name="specialty"
            defaultValue={doctor.specialty ?? ""}
            className="h-9"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pp-interest" className="text-xs">
            Interés (1-5)
          </Label>
          <select
            id="pp-interest"
            name="interest_level"
            className={selectClass}
            defaultValue={doctor.interest_level ?? ""}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pp-acc" className="text-xs">
            Interés en acreditarse
          </Label>
          <select
            id="pp-acc"
            name="accreditation_interest"
            className={selectClass}
            defaultValue={doctor.accreditation_interest ?? ""}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pp-est" className="text-xs">
            Casos/mes estimados
          </Label>
          <Input
            id="pp-est"
            name="estimated_cases_month"
            type="number"
            min="0"
            step="1"
            defaultValue={doctor.estimated_cases_month ?? ""}
            className="h-9"
          />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            name="uses_aligners"
            defaultChecked={doctor.uses_aligners ?? false}
            className="h-4 w-4"
          />
          Ya usa alineadores
        </label>
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Guardando…" : saved ? "Guardado ✓" : "Guardar"}
          </Button>
        </div>
        <div className="space-y-1 sm:col-span-3 lg:col-span-6">
          <Label htmlFor="pp-why" className="text-xs">
            Por qué es interesante
          </Label>
          <Input
            id="pp-why"
            name="why_interesting"
            defaultValue={doctor.why_interesting ?? ""}
            placeholder="Alto volumen, referida por…, clínica grande…"
            className="h-9"
          />
        </div>
      </form>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

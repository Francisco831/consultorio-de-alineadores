"use client";

import { useState, useTransition } from "react";
import { UserPlus } from "lucide-react";
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
import { createProspect } from "@/lib/actions/journey";
import { SOURCE_LABELS } from "@/lib/types";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function NewProspectDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(fd: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await createProspect(fd);
      if (res?.error) setError(res.error);
      else setOpen(false);
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="mr-1.5 h-4 w-4" />
        Nuevo prospecto
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nuevo prospecto</DialogTitle>
            <DialogDescription>
              Doctor que todavía NO trabaja con KeepSmiling. El objetivo:
              lograr que se acredite.
            </DialogDescription>
          </DialogHeader>
          <form action={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-nombre">Nombre *</Label>
              <Input id="np-nombre" name="nombre" required placeholder="Dra. …" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="np-phone">Teléfono / WhatsApp</Label>
                <Input id="np-phone" name="phone" placeholder="+52 …" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-email">Email</Label>
                <Input id="np-email" name="email" type="email" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="np-city">Ciudad</Label>
                <Input id="np-city" name="city" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-specialty">Especialidad</Label>
                <Input id="np-specialty" name="specialty" placeholder="Ortodoncia" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="np-source">Fuente</Label>
                <select id="np-source" name="source" className={selectClass} defaultValue="ventas">
                  {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-clinic">Clínica</Label>
                <Input id="np-clinic" name="clinic_name" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="np-interest">Interés (1-5)</Label>
                <select id="np-interest" name="interest_level" className={selectClass} defaultValue="">
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-acc-interest">Interés acredit.</Label>
                <select id="np-acc-interest" name="accreditation_interest" className={selectClass} defaultValue="">
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-est">Casos/mes est.</Label>
                <Input id="np-est" name="estimated_cases_month" type="number" min="0" step="1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="np-competitor">Competidor actual</Label>
                <Input id="np-competitor" name="competitor" placeholder="Invisalign, Aliwell…" />
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input type="checkbox" name="uses_aligners" className="h-4 w-4" />
                Ya usa alineadores
              </label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-why">Por qué es interesante</Label>
              <Input
                id="np-why"
                name="why_interesting"
                placeholder="Alto volumen de pacientes, referida por la Dra. …"
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Creando…" : "Crear prospecto"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

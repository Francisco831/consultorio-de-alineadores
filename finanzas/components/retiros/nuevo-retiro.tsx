"use client";

// Anotar un retiro en tres toques: quién, cuánto, listo. La fecha y la cuenta
// vienen puestas con lo más probable, y quién retira son botones y no un campo
// de texto porque los mismos dos nombres se repiten todos los meses.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CampoSelect } from "@/components/ui/campo-select";
import { registrarRetiro } from "@/lib/actions/retiros";
import { parseMoneyInput, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { EmpresaSlug } from "@/lib/empresas";

export function NuevoRetiro({
  empresa, cuentas, habituales, hoy, locale,
}: {
  empresa: EmpresaSlug;
  cuentas: Array<{ id: string; name: string; currency: string }>;
  /** Los que ya retiraron alguna vez, más los fijos. */
  habituales: string[];
  hoy: string;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [quien, setQuien] = useState(habituales[0] ?? "");
  const [otro, setOtro] = useState("");
  const [monto, setMonto] = useState("");
  const [cuentaId, setCuentaId] = useState(cuentas[0]?.id ?? "");
  const [fecha, setFecha] = useState(hoy);
  const [nota, setNota] = useState("");

  const quienFinal = (quien === "__otro" ? otro : quien).trim();
  const importe = parseMoneyInput(monto) ?? 0;
  const moneda = cuentas.find((c) => c.id === cuentaId)?.currency ?? "ARS";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!quienFinal) return toast.error("Falta quién retira");
    if (importe <= 0) return toast.error("Falta el monto");
    if (!cuentaId) return toast.error("Falta la cuenta");
    startTransition(async () => {
      const res = await registrarRetiro({
        empresa, quien: quienFinal, amount: importe,
        accountId: cuentaId, occurredOn: fecha, nota: nota.trim() || undefined,
      });
      if (res?.error) { toast.error(res.error); return; }
      toast.success(`Retiro de ${quienFinal} por ${formatMoney(importe, moneda, locale)} anotado`);
      setMonto("");
      setNota("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border p-4">
      <div className="space-y-1.5">
        <Label>Quién retira</Label>
        <div className="flex flex-wrap gap-1.5">
          {habituales.map((h) => (
            <button
              key={h} type="button" onClick={() => setQuien(h)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-[13px] transition-colors hover:bg-accent",
                quien === h && "border-primary bg-accent font-medium"
              )}
            >
              {h}
            </button>
          ))}
          <button
            type="button" onClick={() => setQuien("__otro")}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[13px] transition-colors hover:bg-accent",
              quien === "__otro" && "border-primary bg-accent font-medium"
            )}
          >
            Otro…
          </button>
        </div>
        {quien === "__otro" ? (
          <Input
            autoFocus value={otro} onChange={(e) => setOtro(e.target.value)}
            placeholder="Nombre de quien retira" className="mt-1.5"
          />
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="monto">Monto</Label>
          <Input
            id="monto" inputMode="decimal" value={monto} placeholder="0"
            onChange={(e) => setMonto(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fecha">Fecha</Label>
          <Input id="fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>De qué cuenta</Label>
          <CampoSelect
            value={cuentaId} onValueChange={setCuentaId}
            opciones={cuentas.map((c) => ({ value: c.id, label: `${c.name} (${c.currency})` }))}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="nota">Nota (opcional)</Label>
        <Input
          id="nota" value={nota} onChange={(e) => setNota(e.target.value)}
          placeholder="Para qué, o cualquier cosa que quieras dejar dicha"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {importe > 0 && quienFinal
            ? `${quienFinal} retira ${formatMoney(importe, moneda, locale)}`
            : "Sale de la caja como egreso; no se le liquida a ninguna doctora."}
        </p>
        <Button type="submit" disabled={pending}>
          {pending ? "Anotando…" : "Anotar retiro"}
        </Button>
      </div>
    </form>
  );
}

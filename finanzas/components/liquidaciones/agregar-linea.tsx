"use client";

// Agregar a la liquidación un cobro que la caja no tiene.
//
// La línea no se inventa en la liquidación: se carga el cobro en la caja —un
// movimiento manual, que es por donde entra toda la plata de este sistema— y se
// le imputa la doctora. Así el cobro también aparece en el saldo de la cuenta y
// en la conciliación, que es lo que tiene que pasar cuando entró plata de
// verdad. El diálogo lo dice, porque es la diferencia entre corregir un número
// y declarar un ingreso.
//
// Nativo y con submit explícito, como todo lo que mueve plata en esta pantalla.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { agregarLineaLiquidacion } from "@/lib/actions/liquidaciones";
import { parseMoneyInput } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";

export type CuentaOpcion = { id: string; nombre: string; moneda: string };

/** Último día del período, que es donde cae un cobro que se carga tarde. */
function finDeMes(periodo: string): string {
  const [a, m] = periodo.split("-").map(Number);
  return `${periodo}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function AgregarLinea({
  empresa, profesionalId, doctora, periodo, cuentas, hoy,
}: {
  empresa: EmpresaSlug;
  profesionalId: string;
  doctora: string;
  periodo: string;
  cuentas: CuentaOpcion[];
  /** Hoy en la zona de la empresa: la plata no entra con fecha futura. */
  hoy: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // El período que se ve por defecto es el más nuevo, así que el fin de mes cae
  // adelante: un cobro con fecha futura ensucia el saldo de la cuenta y la
  // conciliación por algo que todavía no pasó.
  const [fecha, setFecha] = useState(finDeMes(periodo) > hoy ? hoy : finDeMes(periodo));
  const [paciente, setPaciente] = useState("");
  const [concepto, setConcepto] = useState("");
  const [monto, setMonto] = useState("");
  const [cuentaId, setCuentaId] = useState(cuentas[0]?.id ?? "");
  const [esAlineadores, setEsAlineadores] = useState(true);
  const moneda = cuentas.find((c) => c.id === cuentaId)?.moneda ?? "ARS";

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    const m = parseMoneyInput(monto);
    if (!m || m <= 0) return toast.error("El monto no es un número");
    if (!cuentaId) return toast.error("Elegí en qué cuenta entró la plata");
    if (paciente.trim().length < 2) return toast.error("Falta el paciente");
    if (concepto.trim().length < 3) return toast.error("Falta el concepto: es lo que la doctora va a leer");
    if (fecha.slice(0, 7) !== periodo) return toast.error(`La fecha tiene que caer en ${periodo}`);

    startTransition(async () => {
      const res = await agregarLineaLiquidacion({
        empresa, profesionalId, periodo, fecha,
        paciente: paciente.trim(), concepto: concepto.trim(), monto: m, cuentaId,
        esAlineadores,
      });
      if (res?.error) toast.error(res.error);
      else {
        setOpen(false);
        setPaciente(""); setConcepto(""); setMonto("");
        toast.success(`Cobro cargado y liquidado a ${doctora} · mes recalculado`);
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <Plus className="size-3" /> Agregar una línea
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Agregar una línea a {doctora}</DialogTitle></DialogHeader>
        <p className="-mt-1 text-sm text-muted-foreground">
          Liquidación de {periodo}. Esto carga un cobro <strong>en la caja</strong> y se lo imputa
          a ella: la plata entró de verdad, así que también va a aparecer en el saldo de la cuenta.
        </p>

        <form className="space-y-3" onSubmit={guardar}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="ag-fecha">Fecha</Label>
              <Input id="ag-fecha" type="date" max={hoy} value={fecha}
                onChange={(e) => setFecha(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ag-monto">Monto ({moneda})</Label>
              <Input id="ag-monto" inputMode="decimal" autoComplete="off"
                value={monto} onChange={(e) => setMonto(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ag-paciente">Paciente</Label>
            <Input id="ag-paciente" autoComplete="off" placeholder="Apellido Nombre"
              value={paciente} onChange={(e) => setPaciente(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ag-concepto">Concepto</Label>
            <Input id="ag-concepto" autoComplete="off" placeholder="cuota 3 de 6 que no entró en la caja"
              value={concepto} onChange={(e) => setConcepto(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ag-cuenta">¿En qué cuenta entró?</Label>
            <select
              id="ag-cuenta" value={cuentaId} onChange={(e) => setCuentaId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-[13px]"
            >
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>{c.nombre} · {c.moneda}</option>
              ))}
            </select>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-transparent p-2 hover:bg-accent has-checked:border-primary has-checked:bg-accent">
            <input
              type="checkbox" name="alineadores" className="mt-0.5 size-4 accent-primary"
              checked={esAlineadores} onChange={(e) => setEsAlineadores(e.target.checked)}
            />
            <span className="text-[13px] leading-tight">
              <span className="font-medium">Es una cuota de alineadores</span>
              <span className="block text-[11px] text-muted-foreground">
                Entonces pasa por el costeo KS. Si el sistema no le puede poner precio, va a
                aparecer en el cartel de “cobros sin costo KS” hasta que se lo cargues — que es
                mejor que liquidarle a la doctora el 40% del bruto sin que nadie lo note.
              </span>
            </span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Cargando…" : "Cargar y recalcular"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

// Alta de compra con varias líneas. El valor está en el detalle: al cargar un
// producto que ya compraste antes, te muestra el precio anterior y cuánto varió
// — que es el momento en que sirve enterarse, no tres meses después.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CampoSelect } from "@/components/ui/campo-select";
import { crearCompra, precioAnterior } from "@/lib/actions/compras";
import { parseMoneyInput, formatMoney } from "@/lib/money";
import type { EmpresaSlug } from "@/lib/empresas";
import { Trash2, Plus } from "lucide-react";

type Linea = {
  productName: string; brand: string; quantity: string; unit: string; unitPrice: string;
  anterior?: { precio: number; fecha: string } | null;
};

const LINEA_VACIA: Linea = { productName: "", brand: "", quantity: "1", unit: "unidad", unitPrice: "" };

export function NuevaCompra({
  empresa, cuentas, categorias, monedas, hoy,
}: {
  empresa: EmpresaSlug;
  cuentas: Array<{ id: string; name: string; currency: string }>;
  categorias: Array<{ id: string; name: string }>;
  monedas: string[];
  hoy: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lineas, setLineas] = useState<Linea[]>([{ ...LINEA_VACIA }]);
  const [settlement, setSettlement] = useState<"paid" | "credit">("paid");
  const [currency, setCurrency] = useState(monedas[0]);

  const total = lineas.reduce((a, l) => {
    const q = Number(l.quantity) || 0;
    const p = parseMoneyInput(l.unitPrice) ?? 0;
    return a + q * p;
  }, 0);

  function actualizar(i: number, campo: keyof Linea, valor: string) {
    setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, [campo]: valor } : l)));
  }

  async function buscarPrecio(i: number, nombre: string) {
    if (!nombre.trim()) return;
    const prev = await precioAnterior(empresa, nombre.trim());
    setLineas((ls) =>
      ls.map((l, j) =>
        j === i
          ? { ...l, anterior: prev ? { precio: Number(prev.precio_ultimo), fecha: String(prev.ultima_compra) } : null }
          : l
      )
    );
  }

  function submit(form: HTMLFormElement) {
    const fd = new FormData(form);
    const items = lineas
      .filter((l) => l.productName.trim() && (parseMoneyInput(l.unitPrice) ?? 0) >= 0)
      .map((l) => ({
        productName: l.productName.trim(),
        brand: l.brand.trim() || undefined,
        quantity: Number(l.quantity) || 0,
        unit: l.unit.trim() || "unidad",
        unitPrice: parseMoneyInput(l.unitPrice) ?? 0,
      }))
      .filter((i) => i.quantity > 0);
    if (!items.length) { toast.error("Cargá al menos una línea con cantidad"); return; }

    startTransition(async () => {
      const res = await crearCompra({
        empresa,
        supplierName: String(fd.get("supplier")),
        purchasedOn: String(fd.get("purchasedOn")),
        currency,
        invoiceNo: (fd.get("invoiceNo") as string) || undefined,
        settlement,
        accountId: settlement === "paid" ? String(fd.get("account")) : undefined,
        dueOn: settlement === "credit" ? String(fd.get("dueOn")) : undefined,
        categoryId: (fd.get("category") as string) || null,
        items,
      });
      if (res?.error) toast.error(res.error);
      else {
        toast.success(
          settlement === "paid" ? "Compra registrada y gasto cargado" : "Compra registrada · quedó en Por pagar"
        );
        router.push(`/${empresa}/compras`);
      }
    });
  }

  const cuentasMoneda = cuentas.filter((c) => c.currency === currency);

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }}>
      <div className="space-y-3 rounded-xl border bg-card p-5 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="supplier">Proveedor</Label>
            <Input id="supplier" name="supplier" required autoFocus placeholder="Se crea si no existe" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="purchasedOn">Fecha</Label>
            <Input id="purchasedOn" name="purchasedOn" type="date" defaultValue={hoy} required />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="invoiceNo">N° factura</Label>
            <Input id="invoiceNo" name="invoiceNo" placeholder="Opcional" />
          </div>
          <div className="space-y-1.5">
            <Label>Moneda</Label>
            <CampoSelect value={currency} onValueChange={setCurrency}
              opciones={monedas.map((m) => ({ value: m, label: m }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Categoría</Label>
            <CampoSelect name="category" placeholder="Sin categoría"
              opciones={categorias.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Condición</Label>
            <CampoSelect value={settlement}
              onValueChange={(v) => setSettlement(v as "paid" | "credit")}
              opciones={[
                { value: "paid", label: "Pagada" },
                { value: "credit", label: "Cuenta corriente" },
              ]} />
          </div>
        </div>
        {settlement === "paid" ? (
          <div className="space-y-1.5">
            <Label>Sale de</Label>
            <CampoSelect name="account" defaultValue={cuentasMoneda[0]?.id}
              opciones={cuentasMoneda.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="dueOn">Vence</Label>
            <Input id="dueOn" name="dueOn" type="date" defaultValue={hoy} required />
            <p className="text-xs text-muted-foreground">Va a aparecer en “Por pagar” hasta que la pagues.</p>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Qué compraste</h2>
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs"
            onClick={() => setLineas((ls) => [...ls, { ...LINEA_VACIA }])}>
            <Plus className="h-3 w-3" /> Agregar línea
          </Button>
        </div>
        <div className="space-y-2">
          {lineas.map((l, i) => {
            const precio = parseMoneyInput(l.unitPrice) ?? 0;
            const variacion = l.anterior && l.anterior.precio > 0 && precio > 0
              ? ((precio / l.anterior.precio - 1) * 100)
              : null;
            return (
              <div key={i} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-4 space-y-1">
                  {i === 0 ? <Label className="text-xs">Producto</Label> : null}
                  <Input value={l.productName} placeholder="Guantes talle M"
                    onChange={(e) => actualizar(i, "productName", e.target.value)}
                    onBlur={(e) => buscarPrecio(i, e.target.value)} />
                </div>
                <div className="col-span-2 space-y-1">
                  {i === 0 ? <Label className="text-xs">Cantidad</Label> : null}
                  <Input value={l.quantity} inputMode="decimal" className="fig text-right"
                    onChange={(e) => actualizar(i, "quantity", e.target.value)} />
                </div>
                <div className="col-span-2 space-y-1">
                  {i === 0 ? <Label className="text-xs">Unidad</Label> : null}
                  <Input value={l.unit} onChange={(e) => actualizar(i, "unit", e.target.value)} />
                </div>
                <div className="col-span-3 space-y-1">
                  {i === 0 ? <Label className="text-xs">Precio unitario</Label> : null}
                  <Input value={l.unitPrice} inputMode="decimal" className="fig text-right"
                    onChange={(e) => actualizar(i, "unitPrice", e.target.value)} />
                  {l.anterior ? (
                    <p className="text-[11px] text-muted-foreground">
                      antes {formatMoney(l.anterior.precio, currency, "es-AR", { decimals: true })}
                      {variacion != null && Math.abs(variacion) >= 1 ? (
                        <span className={variacion > 0 ? "ml-1 font-medium text-red-600 dark:text-red-400" : "ml-1 font-medium text-emerald-600 dark:text-emerald-400"}>
                          {variacion > 0 ? "+" : ""}{variacion.toFixed(0)}%
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                </div>
                <div className="col-span-1 pb-1">
                  {lineas.length > 1 ? (
                    <button type="button" className="text-muted-foreground hover:text-destructive"
                      onClick={() => setLineas((ls) => ls.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-sm text-muted-foreground">Total</span>
          <span className="fig text-xl font-semibold">{formatMoney(total, currency, "es-AR")}</span>
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={pending || total <= 0}>
        {pending ? "Guardando…" : settlement === "paid" ? "Registrar compra y cargar el gasto" : "Registrar compra a cuenta corriente"}
      </Button>
    </form>
  );
}

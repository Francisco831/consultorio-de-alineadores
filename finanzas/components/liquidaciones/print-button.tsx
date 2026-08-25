"use client";

import { Button } from "@/components/ui/button";

// El PDF sale del diálogo de impresión del navegador ("Guardar como PDF"):
// cero dependencias y la doctora recibe exactamente lo que se ve en pantalla.
export function PrintButton() {
  return (
    <Button onClick={() => window.print()} className="print:hidden">
      Imprimir / Guardar PDF
    </Button>
  );
}

"use client";

// Select con etiquetas. Base UI muestra el VALOR crudo en el trigger salvo que
// se le pase el mapa `items` (value → label): sin esto un select de cuentas
// mostraba el UUID y uno de tipos mostraba "bank" en vez de "Banco".
// Además fuerza w-full: el trigger de Base UI es w-fit y se superponía con el
// campo de al lado dentro de una grilla.

import { useMemo } from "react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type Opcion = { value: string; label: string };

export function CampoSelect({
  name, opciones, defaultValue, value, onValueChange, placeholder, className, disabled,
}: {
  name?: string;
  opciones: Opcion[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const items = useMemo(
    () => Object.fromEntries(opciones.map((o) => [o.value, o.label])),
    [opciones]
  );
  return (
    <Select
      name={name}
      items={items}
      defaultValue={defaultValue}
      value={value}
      onValueChange={onValueChange ? (v) => onValueChange((v as string) ?? "") : undefined}
      disabled={disabled}
    >
      <SelectTrigger className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {opciones.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

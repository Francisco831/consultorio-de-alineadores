"use client";

// Qué línea de WhatsApp atiende cada uno (26/8). Es un solo campo por fila, así
// que no hay botón Guardar: el select guarda al soltarlo y avisa ahí mismo.

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { setLineaPeriskope } from "@/lib/actions/team";

const selectClass =
  "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/**
 * Las 5 líneas que existen hoy en la organización de Periskope, en orden de
 * cuántos chats tenía cada una en el export del 7/8 (939 · 352 · 323 · 284 · 8).
 * Van escritas acá porque el plan de Periskope no expone las líneas por API:
 * cuando se sume o se dé de baja una, se toca esta lista.
 */
const LINEAS_PERISKOPE = [
  { phone: "5215549149356", nombre: "Ortodoncia Keep" },
  { phone: "5215547940498", nombre: "sin nombre" },
  { phone: "5216642962789", nombre: "Keep Smiling" },
  { phone: "5215510685144", nombre: "Juan" },
  { phone: "5491123740762", nombre: "Dra. Rocío Puig" },
];

function etiqueta(phone: string): string {
  const linea = LINEAS_PERISKOPE.find((l) => l.phone === phone);
  return `…${phone.slice(-4)} — ${linea ? linea.nombre : "otra línea"}`;
}

export interface MiembroEquipo {
  id: string;
  nombre: string;
  rol: string;
  periskope_org_phone: string | null;
}

export function LineasManager({ equipo }: { equipo: MiembroEquipo[] }) {
  // El valor elegido vive acá y no en el DOM: si RLS rechaza el cambio, hay que
  // volver al anterior en vez de dejar en pantalla una línea que la base no tiene.
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(equipo.map((p) => [p.id, p.periskope_org_phone ?? ""]))
  );
  const [okId, setOkId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; msg: string } | null>(null);
  const [filaActiva, setFilaActiva] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function guardar(fd: FormData, id: string, anterior: string) {
    const nuevo = String(fd.get("linea") ?? "");
    setOkId(null);
    setError(null);
    setFilaActiva(id);
    setValores((v) => ({ ...v, [id]: nuevo }));
    startTransition(async () => {
      const res = await setLineaPeriskope(fd);
      if ("error" in res) {
        setValores((v) => ({ ...v, [id]: anterior }));
        setError({ id, msg: res.error });
        return;
      }
      setOkId(id);
      setTimeout(
        () => setOkId((actual) => (actual === id ? null : actual)),
        3000
      );
    });
  }

  return (
    <ul className="divide-y rounded-lg border">
      {equipo.map((p) => {
        const valor = valores[p.id] ?? "";
        const desconocida =
          valor !== "" && !LINEAS_PERISKOPE.some((l) => l.phone === valor);
        return (
          <li key={p.id} className="px-4 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {p.nombre}{" "}
                <span className="text-xs text-muted-foreground">{p.rol}</span>
              </span>
              <div className="flex items-center gap-2">
                <form action={(fd) => guardar(fd, p.id, valor)}>
                  <input type="hidden" name="user_id" value={p.id} />
                  <select
                    name="linea"
                    aria-label={`Línea de WhatsApp de ${p.nombre}`}
                    className={selectClass}
                    value={valor}
                    disabled={pending}
                    // un solo campo: se guarda al elegir, sin botón de por medio
                    onChange={(e) => e.currentTarget.form?.requestSubmit()}
                  >
                    <option value="">Sin línea asignada</option>
                    {LINEAS_PERISKOPE.map((l) => (
                      <option key={l.phone} value={l.phone}>
                        …{l.phone.slice(-4)} — {l.nombre}
                      </option>
                    ))}
                    {/* Una línea ya cargada que no esté en la lista de arriba
                        tiene que poder verse y conservarse igual */}
                    {desconocida ? (
                      <option value={valor}>{etiqueta(valor)}</option>
                    ) : null}
                  </select>
                </form>
                {pending && filaActiva === p.id ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
                {okId === p.id ? (
                  <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                    <Check className="h-4 w-4" /> Guardado
                  </span>
                ) : null}
              </div>
            </div>
            {error?.id === p.id ? (
              <p className="mt-1 text-sm text-red-600">{error.msg}</p>
            ) : null}
          </li>
        );
      })}
      {equipo.length === 0 ? (
        <li className="px-4 py-3 text-sm text-muted-foreground">
          Sin usuarios cargados.
        </li>
      ) : null}
    </ul>
  );
}

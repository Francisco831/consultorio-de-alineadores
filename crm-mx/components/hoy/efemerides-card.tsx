import Link from "next/link";
import { Cake, MessageCircle, PartyPopper } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { waLink } from "@/lib/phone";
import type { Efemeride } from "@/lib/types";
import { cn } from "@/lib/utils";

// Títulos y grados con los que el equipo carga los nombres en el CRM. Se sacan
// antes de buscar el apellido, si no el saludo sale "Dr./Dra. Dra".
const TITULOS = new Set([
  "dr",
  "dr.",
  "dra",
  "dra.",
  "doctor",
  "doctora",
  "od",
  "od.",
  "esp",
  "esp.",
  "mtro",
  "mtra",
  "cd",
  "cd.",
]);

/**
 * El primer apellido, para saludar por apellido y no por el nombre entero.
 *
 * En México los nombres del CRM vienen casi siempre como "Nombre(s) Apellido
 * Materno" ("Aaron Abraham Cortez Chavez" → Cortez, "Abel Ramírez Farfán" →
 * Ramírez), así que el anteúltimo token acierta en la enorme mayoría. Es una
 * heurística: el texto del WhatsApp queda escrito pero lo manda una persona,
 * que lo corrige si salió raro.
 */
function primerApellido(nombre: string): string {
  const partes = nombre
    .trim()
    .split(/\s+/)
    .filter((p) => !TITULOS.has(p.toLowerCase()));
  if (!partes.length) return nombre.trim();
  const elegido =
    partes.length >= 3 ? partes[partes.length - 2] : partes[partes.length - 1];
  // los nombres cargados en MAYÚSCULAS gritan en el saludo
  return elegido.charAt(0).toUpperCase() + elegido.slice(1).toLowerCase();
}

/** "Cumple 45 años" / "3 años como acreditado" */
function queSeFesteja(e: Efemeride): string {
  if (e.tipo === "cumple")
    return e.anios != null ? `Cumple ${e.anios} años` : "Cumple años";
  if (e.anios == null) return "Aniversario como acreditado";
  return `${e.anios} ${e.anios === 1 ? "año" : "años"} como acreditado`;
}

/** El saludo ya escrito: quien abre WhatsApp solo tiene que apretar enviar. */
function saludo(e: Efemeride): string {
  return e.tipo === "cumple"
    ? `¡Feliz cumpleaños, Dr./Dra. ${primerApellido(e.nombre)}!`
    : "¡Felicitaciones por su aniversario con KeepSmiling!";
}

/**
 * Cumpleaños y aniversarios de acreditación de la semana (RPC
 * doctores_efemerides, migración 0040).
 *
 * La lista viene de la base ordenada por fecha, o sea que el de AYER queda
 * primero: acá se reordena para que los de hoy encabecen, que son los únicos
 * que se pierden si nadie los ve a tiempo.
 */
export function EfemeridesCard({ efemerides }: { efemerides: Efemeride[] }) {
  // sin nada que saludar el bloque no existe: /hoy ya tiene suficientes cajas
  if (!efemerides.length) return null;

  const orden = [...efemerides].sort(
    (a, b) =>
      (a.dias === 0 ? -99 : a.dias) - (b.dias === 0 ? -99 : b.dias) ||
      a.nombre.localeCompare(b.nombre, "es")
  );

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Fechas para saludar
      </h2>
      <ul className="divide-y rounded-lg border">
        {orden.map((e) => {
          const wa = waLink(e.whatsapp ?? e.phone, saludo(e));
          const Icono = e.tipo === "cumple" ? Cake : PartyPopper;
          return (
            <li
              key={`${e.doctor_id}-${e.tipo}`}
              className={cn(
                "flex items-center justify-between gap-2 px-3 py-2 text-sm",
                e.dias === 0 && "bg-emerald-500/5"
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Icono
                  className={cn(
                    "h-4 w-4 shrink-0",
                    e.dias === 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground"
                  )}
                />
                <div className="min-w-0">
                  <Link
                    href={`/doctores/${e.doctor_id}`}
                    className="block truncate font-medium hover:underline"
                  >
                    {e.nombre}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {queSeFesteja(e)} ·{" "}
                    {e.dias === 0 ? (
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                        HOY
                      </span>
                    ) : e.dias < 0 ? (
                      "fue ayer"
                    ) : e.dias === 1 ? (
                      "mañana"
                    ) : (
                      `en ${e.dias} días`
                    )}
                    {e.city ? ` · ${e.city}` : ""}
                  </span>
                </div>
              </div>
              {wa ? (
                <a
                  href={wa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon-sm" }),
                    "shrink-0"
                  )}
                  title="Saludar por WhatsApp"
                >
                  <MessageCircle />
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

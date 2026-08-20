// Normalización de medios de pago de la caja del consultorio.
// Los datos reales (877 movimientos Ene–Jul 2026) traen 31 variantes de 4
// medios; estas reglas las reducen a un canónico. Lo que no matchea NO se
// inventa: va a la cuenta "Sin medio (a revisar)".

import { norm } from "./normalize";

export type MedioCanonico = "ks" | "mp" | "efectivo" | "coni";

export function esUsd(medioRaw: string | null | undefined): boolean {
  const n = norm(medioRaw);
  return /u\$s|us\$|usd/.test(n);
}

/** null = no identificable (86 vacíos + basura tipo "Abona cuota1 de 6..."). */
export function medioCanonico(medioRaw: string | null | undefined): MedioCanonico | null {
  const n = norm(medioRaw);
  if (!n) return null;
  if (/^(tr|depo)\s*\.?\s*coni/.test(n)) return "coni";
  if (/^(tr|depo)\s*\.?\s*ks/.test(n)) return "ks";
  // "TR MP", "Tr mp", "mp", "TR MP Basilico-Lavalle"
  if (/^(tr\s*\.?\s*)?mp\b/.test(n)) return "mp";
  if (/^ef(e|ectivo)?\b/.test(n) || n === "ef") return "efectivo";
  return null;
}

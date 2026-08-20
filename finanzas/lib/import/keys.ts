// external_key de imports: basado en CONTENIDO (re-importar = incremental
// gratis) + ordinal intra-clave (dos consultas idénticas el mismo día son
// legítimas y deben generar claves distintas).

import { createHash } from "node:crypto";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Genera claves determinísticas con ordinal para contenidos repetidos.
 *  El MISMO recorrido del MISMO archivo produce las mismas claves. */
export class KeyBuilder {
  private seen = new Map<string, number>();

  build(prefix: string, ...parts: Array<string | number | null | undefined>): string {
    const base = `${prefix}:${sha256Hex(parts.map((p) => String(p ?? "")).join("|")).slice(0, 16)}`;
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  }
}

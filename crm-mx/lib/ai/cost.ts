// Costo estimado por corrida (Fase 3, §56).
//
// Para qué: sin números no se puede decidir con qué modelo correr ni cada cuánto
// re-analizar un doctor. Es una ESTIMACIÓN para tomar decisiones, no una factura:
// la verdad la tiene la consola de Anthropic.
//
// Precios por millón de tokens (USD), verificados el 9/8/2026:
//   claude-opus-5    entrada 5,00   salida 25,00
//   claude-sonnet-5  entrada 3,00   salida 15,00  (promo de lanzamiento 2,00 / 10,00 hasta el 31/8/2026)
//   claude-haiku-4-5 entrada 1,00   salida  5,00
//
// Caché: la lectura cuesta ~0,1× el precio de entrada; la escritura 1,25× con TTL
// de 5 minutos y 2× con TTL de 1 hora.
//
// EL TTL SE DECIDE ACÁ, no en el runner, y el runner importa la constante. Es a
// propósito: el multiplicador de escritura depende del TTL, así que si cada módulo
// eligiera el suyo, cambiar el TTL en el runner dejaría el costo reportado por
// debajo del real y nadie se enteraría. El módulo que sabe el precio es el que
// elige la duración.

export interface ModelPrice {
  /** USD por millón de tokens de entrada NO cacheados. */
  input: number;
  /** USD por millón de tokens de salida. */
  output: number;
}

/** TTL del caché de prompt. Lo consume `lib/ai/runner.ts` en `cache_control`. */
export const CACHE_TTL: "5m" | "1h" = "1h";

const MULTIPLICADOR_CACHE_READ = 0.1;
const MULTIPLICADOR_CACHE_WRITE = CACHE_TTL === "1h" ? 2 : 1.25;

/** Precios de lista. Si aparece un modelo desconocido se estima con el de Opus
 *  (el más caro): es preferible sobreestimar el costo que subestimarlo. */
const PRECIOS: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const PRECIO_POR_DEFECTO: ModelPrice = { input: 5, output: 25 };

export function priceFor(model: string): ModelPrice {
  return PRECIOS[model] ?? PRECIO_POR_DEFECTO;
}

export interface CostInput {
  model: string;
  /** Tokens de entrada que NO vinieron del caché ni lo escribieron. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Costo estimado en USD. Devuelve null si los contadores no son utilizables
 * (una corrida que falló antes de llamar al modelo no cuesta nada y no debe
 * guardar un cero que se confunda con "salió gratis").
 */
export function estimateCostUsd(o: CostInput): number | null {
  const limpio = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const input = limpio(o.input);
  const cacheRead = limpio(o.cacheRead);
  const cacheWrite = limpio(o.cacheWrite);
  const output = limpio(o.output);
  if (input + cacheRead + cacheWrite + output === 0) return null;

  const p = priceFor(o.model);
  const usd =
    (input * p.input +
      cacheRead * p.input * MULTIPLICADOR_CACHE_READ +
      cacheWrite * p.input * MULTIPLICADOR_CACHE_WRITE +
      output * p.output) /
    1_000_000;
  // 5 decimales = el precision del campo cost_usd en agent_runs (0026).
  return Math.round(usd * 1e5) / 1e5;
}

// Etiquetas del doctor (doctors.tags).
//
// Son el canal para armar LISTAS: "los que van al Summit 2026", "interesados en
// el escáner". El texto libre (actividades, observaciones) se busca; la
// etiqueta se filtra y se cuenta. Por eso el formato es rígido: si Rocío carga
// "Summit 2026" y Juan "summit-2026", la lista sale partida en dos. Acá las dos
// quedan iguales.
//
// El formato que exige la base (check doctors_tags_formato, migración 0061):
// empieza con letra o número; después letras, números, ':' '.' '_' '-'; hasta 60.
// Acá se recorta a 40, que alcanza y entra en un chip.

const MAX = 40;

/**
 * "Summit 2026" → "summit-2026"; "  Interesado en Escáner " → "interesado-en-escaner";
 * "#KeepDay" → "keepday"; "evento: Summit" → "evento:summit"; "Niños" → "ninos".
 * Devuelve "" si no queda nada usable (solo símbolos, vacío).
 */
export function normalizarEtiqueta(raw: string): string {
  let t = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // acentos y la virgulilla de la ñ: "escáner" → "escaner", "niños" → "ninos"
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[\s_]+/g, "-") // espacios y guiones bajos → guion
    .replace(/[^a-z0-9:._-]/g, "") // cualquier otro símbolo se va
    .replace(/-{2,}/g, "-")
    .replace(/-*:-*/g, ":") // "evento : summit" → "evento:summit"
    .replace(/^[^a-z0-9]+/, ""); // tiene que arrancar con letra o número
  t = t.slice(0, MAX).replace(/[-.:_]+$/, ""); // y no terminar en símbolo
  return t;
}

/**
 * Etiquetas que pone el sistema, no una persona: las escriben los imports y
 * scripts/tag-seguidores-ig.ts, y una persona no las tiene que poder borrar
 * (ni crear con ese prefijo, para que no se confundan con las del censo).
 */
const PREFIJOS_DEL_SISTEMA = [
  "fuente:",
  "competidor:",
  "ig:",
  "ig-alt:",
  "ig-accion:",
  "ig-prioridad:",
  "pais:",
];
const EXACTAS_DEL_SISTEMA = new Set(["sigue-instagram"]);

export function esEtiquetaDelSistema(tag: string): boolean {
  return (
    EXACTAS_DEL_SISTEMA.has(tag) ||
    PREFIJOS_DEL_SISTEMA.some((p) => tag.startsWith(p))
  );
}

/** Para mostrar: "evento:summit-2026" → "evento: summit 2026". */
export function etiquetaLegible(tag: string): string {
  const i = tag.indexOf(":");
  if (i > 0) return `${tag.slice(0, i)}: ${tag.slice(i + 1).replace(/-/g, " ")}`;
  return tag.replace(/-/g, " ");
}

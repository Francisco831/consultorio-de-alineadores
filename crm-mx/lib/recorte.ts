// El buscador de notas muestra un pedazo del texto donde aparece lo buscado,
// no la nota entera: una actividad puede tener 500 caracteres y el resultado
// tiene una línea.

/**
 * Ventana de ~`ancho` caracteres de `texto` centrada en la primera aparición
 * de `q` (sin distinguir mayúsculas). Si `q` no aparece —el match fue en otra
 * columna— devuelve el comienzo. Marca con "…" lo que quedó afuera.
 */
export function recortarAlrededor(texto: string, q: string, ancho = 90): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (limpio.length <= ancho) return limpio;

  const clave = q.trim().toLowerCase();
  const i = clave ? limpio.toLowerCase().indexOf(clave) : -1;
  if (i < 0) return cortarEnPalabra(limpio, 0, ancho) + "…";

  const mitad = Math.floor((ancho - clave.length) / 2);
  let inicio = Math.max(0, i - mitad);
  const fin = Math.min(limpio.length, inicio + ancho);
  if (fin - inicio < ancho) inicio = Math.max(0, fin - ancho);

  return (
    (inicio > 0 ? "…" : "") +
    cortarEnPalabra(limpio, inicio, fin) +
    (fin < limpio.length ? "…" : "")
  );
}

/** El pedazo [inicio, fin), corrido hasta un espacio cercano para no partir palabras. */
function cortarEnPalabra(s: string, inicio: number, fin: number): string {
  let a = inicio;
  let b = fin;
  if (a > 0) {
    const sp = s.indexOf(" ", a);
    if (sp !== -1 && sp - a <= 12) a = sp + 1;
  }
  if (b < s.length) {
    const sp = s.lastIndexOf(" ", b);
    if (sp > a && b - sp <= 12) b = sp;
  }
  return s.slice(a, b).trim();
}

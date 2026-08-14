// Clave canónica de teléfono para MATCHEAR doctores entre fuentes.
//
// OJO, no confundir con lib/phone.ts (el de la app): ese es para deeplinks de
// WhatsApp y CONSERVA el prefijo 521, porque wa.me lo necesita. Este colapsa
// 521→52 justamente para que el mismo número de dos fuentes distintas produzca
// la misma clave. Son dos semánticas distintas del mismo dato y por eso viven
// separadas a propósito.
//
// La regla de los 10 dígitos es la correcta para México y existía en UNA sola de
// las tres copias que había dando vueltas (import-prospectos-fuentes la tenía;
// import-prospectos y merge-prospect-dups no). Un número de 10 dígitos y el mismo
// número con lada de país son el mismo teléfono, y sin esta línea generaban claves
// distintas: el mismo doctor no matcheaba entre corridas.

/**
 * Solo dígitos · 521XXXXXXXXXX (móvil legacy) → 52XXXXXXXXXX · 10 dígitos → +52.
 * Devuelve null si no queda un número usable.
 */
export function canonPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = String(p).replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("521")) d = "52" + d.slice(3);
  if (d.length === 10) d = "52" + d;
  return d.length >= 10 ? d : null;
}

/** Clave canónica de email: recortado y en minúsculas. */
export function canonEmail(e: string | null | undefined): string | null {
  const v = String(e ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

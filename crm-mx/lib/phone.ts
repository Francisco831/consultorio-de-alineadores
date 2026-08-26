// LA CONSOLA DE PERISKOPE NO ACEPTA LA LÍNEA POR URL — verificado el 26/8/2026
// leyendo el bundle de console.periskope.app. La consola elige con qué línea de
// la organización estás mirando (el dropdown de arriba) combinando ese dropdown
// con localStorage (`activePhoneMap`); NO hay parámetro de query, hash ni
// segmento de path que la fuerce. O sea: este link abre el chat, pero se abre en
// la línea que el navegador de esa persona tenga guardada de la última vez.
// Si abre uno con la línea equivocada, la conversación se ve vacía o incompleta.
//
// No pierdas medio día buscando el parámetro dentro de seis meses: no existe.
// Lo único que fuerza la línea es del lado de Periskope, poniendo a la persona
// como miembro NO-admin con sus org_phones acotados a su línea (los admin ven
// todas y por eso pueden equivocarse). Ver docs/WHATSAPP_PERISKOPE.md.
//
// Mientras tanto, el CRM hace lo que sí puede: DECIR en qué línea vive cada chat
// (lineaCorta / lineaPropia, más abajo) para que quien lo abre sepa si tiene que
// cambiar de línea antes de escribir.

/** Link directo al chat en la consola de Periskope (donde trabaja el equipo) */
export function periskopeLink(chatId: string | null): string | null {
  if (!chatId) return null;
  return `https://console.periskope.app/chats/${encodeURIComponent(chatId)}`;
}

/**
 * Las últimas 4 cifras de una línea, que es como el equipo las nombra en voz
 * alta ("la ...5144 es la de Juan"). null si no hay línea o no tiene 4 dígitos.
 */
export function lineaCorta(linea: string | null | undefined): string | null {
  if (!linea) return null;
  const digits = String(linea).replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * ¿Este chat pasa por MI línea?
 *   true  → sí, lo puedo contestar desde donde estoy parado
 *   false → no, el chat vive en otra línea de la organización
 *   null  → falta el dato (no sé mi línea, o el chat no tiene ninguna cargada):
 *           mejor no decir nada que decir algo falso
 *
 * Compara por dígitos y, como red, por los últimos 10: WhatsApp escribe los
 * móviles mexicanos con y sin el "1" de más (5215510685144 vs 525510685144) y
 * son el mismo aparato.
 */
export function lineaPropia(
  lineas: string[] | null | undefined,
  miLinea: string | null | undefined
): boolean | null {
  if (!miLinea || !lineas?.length) return null;
  const mia = String(miLinea).replace(/\D/g, "");
  if (!mia) return null;
  const miCola = mia.slice(-10);
  return lineas.some((l) => {
    const d = String(l ?? "").replace(/\D/g, "");
    if (!d) return false;
    return d === mia || (d.length >= 10 && d.slice(-10) === miCola);
  });
}

/** Normaliza teléfonos MX para deeplinks wa.me / tel: */
export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  // prefijo troncal viejo 044/045 + 10 dígitos (pre-2019): rescatar el número
  if (/^04[45]\d{10}$/.test(digits)) digits = digits.slice(3);
  // 10 dígitos = número mexicano sin código de país
  if (digits.length === 10) return `52${digits}`;
  // 521XXXXXXXXXX (formato WhatsApp viejo) o 52XXXXXXXXXX
  if (digits.startsWith("521") && digits.length === 13) return digits;
  if (digits.startsWith("52") && digits.length === 12) return digits;
  // otro país con código incluido (ej. AR 54...): aceptar largo E.164 plausible
  if (digits.length >= 11 && digits.length <= 15 && !digits.startsWith("52")) {
    return digits;
  }
  return null; // no parseable: mejor ocultar el botón que un link roto
}

export function waLink(raw: string | null, text?: string): string | null {
  const phone = normalizePhone(raw);
  if (!phone) return null;
  const base = `https://wa.me/${phone}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

export function telLink(raw: string | null): string | null {
  const phone = normalizePhone(raw);
  if (!phone) return null;
  // el "1" móvil tras +52 se abolió en 2019; para marcar se quita
  const dial =
    phone.startsWith("521") && phone.length === 13 ? `52${phone.slice(3)}` : phone;
  return `tel:+${dial}`;
}

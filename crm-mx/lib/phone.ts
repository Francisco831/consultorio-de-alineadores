/** Link directo al chat en la consola de Periskope (donde trabaja el equipo) */
export function periskopeLink(chatId: string | null): string | null {
  if (!chatId) return null;
  return `https://console.periskope.app/chats/${encodeURIComponent(chatId)}`;
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

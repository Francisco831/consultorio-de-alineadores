/**
 * Las líneas de WhatsApp de la organización en Periskope: teléfono (solo
 * dígitos, como profiles.periskope_org_phone) y el nombre con que se muestran.
 * Viven en PERISKOPE_LINEAS y no en el código porque el repo es público:
 *
 *   PERISKOPE_LINEAS="5215500000001=Ortodoncia Keep;5215500000002=Juan"
 *
 * Entradas separadas por ";", teléfono y nombre por "=". El orden se respeta:
 * es el orden del select de Ajustes → Líneas (por cuántos chats tenía cada una
 * en el export del 7/8). El plan de Periskope no expone las líneas por API:
 * cuando se sume o se dé de baja una, se toca la variable, no el código.
 */
export interface LineaPeriskope {
  phone: string;
  nombre: string;
}

export function lineasPeriskope(
  valor: string | undefined = process.env.PERISKOPE_LINEAS
): LineaPeriskope[] {
  return (valor ?? "")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const i = e.indexOf("=");
      const phone = (i >= 0 ? e.slice(0, i) : e).replace(/\D/g, "");
      const nombre = i >= 0 ? e.slice(i + 1).trim() : "";
      return { phone, nombre: nombre || "sin nombre" };
    })
    // mismo rango que el CHECK de la 0041 (11 a 15 dígitos)
    .filter((l) => l.phone.length >= 11 && l.phone.length <= 15);
}

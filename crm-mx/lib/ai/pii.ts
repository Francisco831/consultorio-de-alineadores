/**
 * Minimización de datos personales en lo que viaja al modelo.
 *
 * QUÉ PROBLEMA RESUELVE
 * El contexto del doctor y las tools de lectura llevaban teléfono, WhatsApp y
 * **nombres de paciente** (hay 1.016 en la base). Todo eso se serializa en el prompt
 * y sale a un tercero. Al 11/8/2026 no había salido nunca —`agent_runs` = 0 en las
 * dos bases— y por eso se minimiza ANTES de cargar la clave: mientras nada salió,
 * esto es una edición de código; después es una conversación sobre datos que ya se
 * fueron.
 *
 * EL CRITERIO, EN UNA LÍNEA
 * El modelo decide QUÉ hacer y POR QUÉ. Ejecutar lo hace el CRM con la sesión del
 * usuario. Entonces al modelo le hacen falta las señales, no los datos de contacto:
 * el teléfono se usa al mandar, y eso pasa en la pantalla, no en el prompt.
 *
 * QUÉ SE SACA Y QUÉ NO
 *   sale del prompt   teléfono y WhatsApp del doctor → se reemplazan por si el canal
 *                     existe (`has_phone` / `has_whatsapp`), que es lo único que el
 *                     agente necesita para proponer "mandale un WhatsApp".
 *   sale del prompt   nombre del paciente (oportunidades y casos) → referencia corta
 *                     y estable. El modelo dice "la oportunidad OP-3F9A2C"; la
 *                     pantalla muestra "Juana Pérez" al lado, porque el dato sigue
 *                     en la base.
 *   sale del prompt   nombre del chat de WhatsApp: suele ser el nombre de una persona.
 *   SE QUEDA          el nombre del doctor. Hace falta para redactar ("Hola Dr. X") y
 *                     es la contraparte comercial, no un tercero ajeno a la relación.
 *
 * LO QUE ESTO NO ES
 * No borra nada de la base ni de la interfaz. `lib/ai/context.ts` lo importan solo
 * `orchestrator.ts`, `tools/read.ts` y el harness: las pantallas leen la base directo
 * y siguen mostrando teléfono y paciente igual que antes.
 */

/**
 * Referencia corta y estable para nombrar algo sin nombrar a la persona.
 *
 * Sale del id, así que es determinística: el mismo registro produce siempre la misma
 * referencia, dentro de una corrida y entre corridas. Eso importa porque el modelo
 * la va a repetir en su recomendación y la interfaz tiene que poder resolverla.
 *
 * No es reversible sin la base — que es justamente lo que se quiere: para cualquiera
 * que vea el prompt sin acceso al CRM, `OP-3F9A2C` no dice nada de nadie.
 */
export function refCorta(prefijo: string, id: string): string {
  const limpio = id.replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase();
  return `${prefijo}-${limpio || "000000"}`;
}

/** Oportunidades: `OP-3F9A2C`. */
export const refOportunidad = (id: string): string => refCorta("OP", id);

/**
 * Detecta secuencias que parecen un teléfono.
 *
 * Se usa en el test de regresión sobre el bloque de prompt ya armado: si alguien
 * vuelve a meter un teléfono en el contexto, el test falla antes del merge. NO se usa
 * en runtime para abortar una corrida — un falso positivo sobre un monto o un id
 * rompería el producto, y la garantía que importa es que no se escriba el código, no
 * que se caiga al ejecutarlo.
 *
 * Cubre los formatos que hay en la base: `+52...`, `52...` y crudos de 10 dígitos,
 * con o sin espacios, guiones o paréntesis.
 */
export function pareceTelefono(texto: string): string[] {
  // Los uuid se sacan antes de mirar: un id como 00000000-0000-4000-8000-... tiene
  // corridas largas de dígitos y daba falso positivo. Un uuid nunca es un teléfono.
  const sinIds = texto.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    " "
  );
  // No se intenta adivinar el formato —hay demasiados: "+52 33 1234 5678",
  // "5215512345678", "33-1234-5678"— sino agarrar cualquier corrida de dígitos con
  // separadores y CONTAR. Un teléfono mexicano tiene 10 dígitos, o 12 con el 52.
  const encontrados: string[] = [];
  for (const m of sinIds.matchAll(/\+?\d[\d\s().-]{8,}\d/g)) {
    const soloDigitos = m[0].replace(/\D/g, "");
    // 10 = nacional · 12 = con 52 · 13 = con el prefijo móvil legacy 521, que es
    // justamente como vienen los números en wa_conversations de esta base.
    // Una fecha (20260811) tiene 8 y un monto no cae en ninguno de los tres.
    if (![10, 12, 13].includes(soloDigitos.length)) continue;
    // Un solo dígito repetido es relleno de prueba, no un número real.
    if (/^(\d)\1+$/.test(soloDigitos)) continue;
    encontrados.push(m[0].trim());
  }
  return encontrados;
}

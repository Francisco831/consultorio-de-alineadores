/**
 * Geografía comercial de México: las 6 zonas y las 32 entidades federativas.
 *
 * Pedido de Juan (WhatsApp, 27/8/26): la ficha del doctor tiene que tener el
 * Estado como celda propia, y la Zona tiene que ofrecer estas seis y ninguna
 * otra —"Estado: Nuevo León, Ciudad: Monterrey, Zona: Norte".
 *
 * QUÉ HABÍA ANTES, Y POR QUÉ NO SERVÍA
 * El vocabulario viejo era CDMX / Norte / Sur / Foráneos, y "Foráneos" no es una
 * zona: es el cajón donde `derive_zona()` (scripts/parse_enrichment.py) tiraba
 * todo lo que no caía en las otras tres. Por eso Jalisco, Querétaro, Guanajuato
 * y Michoacán —58 fichas, un tercio de las que tenían zona— compartían etiqueta
 * con Los Cabos. Un corte por zona hecho así no informa nada.
 *
 * LA ZONA ES FUNCIÓN DEL ESTADO
 * No hay criterio comercial que discutir: un doctor de Nuevo León está en Norte.
 * Por eso el mapa cubre las 32 entidades —no hay estado sin zona— y la lista de
 * estados del formulario sale de sus claves, así que las dos no pueden quedar
 * desalineadas. La migración 0049 usó exactamente este mapa para reescribir las
 * 171 fichas que ya tenían zona.
 */

export const ZONAS_MX = [
  "Norte",
  "Bajío",
  "CDMX",
  "Centro",
  "Occidente",
  "Sur",
] as const;

export type ZonaMx = (typeof ZONAS_MX)[number];

/**
 * Las 32 entidades → su zona. Alfabético, con el nombre tal cual se guarda en
 * `doctors.state`. "Estado de México" y no "México" a propósito: es como lo
 * escribe el equipo y como quedó en la base, y evita confundirlo con el país.
 */
export const ZONA_POR_ESTADO: Record<string, ZonaMx> = {
  Aguascalientes: "Bajío",
  "Baja California": "Norte",
  "Baja California Sur": "Norte",
  Campeche: "Sur",
  Chiapas: "Sur",
  Chihuahua: "Norte",
  "Ciudad de México": "CDMX",
  Coahuila: "Norte",
  Colima: "Occidente",
  Durango: "Norte",
  "Estado de México": "Centro",
  Guanajuato: "Bajío",
  Guerrero: "Sur",
  Hidalgo: "Centro",
  Jalisco: "Occidente",
  Michoacán: "Occidente",
  Morelos: "Centro",
  Nayarit: "Occidente",
  "Nuevo León": "Norte",
  Oaxaca: "Sur",
  Puebla: "Centro",
  Querétaro: "Bajío",
  "Quintana Roo": "Sur",
  "San Luis Potosí": "Bajío",
  Sinaloa: "Norte",
  Sonora: "Norte",
  Tabasco: "Sur",
  Tamaulipas: "Norte",
  Tlaxcala: "Centro",
  Veracruz: "Sur",
  Yucatán: "Sur",
  Zacatecas: "Bajío",
};

/** Las 32, en orden alfabético. Sale del mapa: no pueden desalinearse. */
export const ESTADOS_MX = Object.keys(ZONA_POR_ESTADO);

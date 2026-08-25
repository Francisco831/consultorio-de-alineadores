// Lo que cada paciente pactó pagar, y las excepciones del costeo.
//
// Vivía dentro de scripts/liquidaciones.ts, que sólo corre en la terminal. Al
// poder recalcular desde el panel, la misma tabla la necesitan los dos: si se
// duplicara, el día que Pancho agregue un pacto acá y no allá el mismo cobro
// pasaría a costear distinto según quién apretó el botón.

/**
 * Etapas adicionales que NO cargan costo KS: vienen incluidas en el programa.
 *
 * Estar acá es una decisión declarada, y le gana al tipo de tratamiento: sin
 * esto, el caso queda a merced de lo que diga (o no diga) Noloco. Daira
 * Castellón entró el 25/8/26 por decisión de Pancho — ese mismo día se había
 * cargado su etapa a $498.000 por creerla un Medium, y al día siguiente
 * confirmó que no lleva costo.
 */
export const ETAPA_ADICIONAL = new Set([
  "cugat fernanda", "fernanda cugat",
  "daira castellon", "castellon daira",
]);

/**
 * Precio KS de una ETAPA ADICIONAL, por paciente.
 *
 * La etapa adicional viene incluida en el programa 1 a 4 sólo cuando el
 * tratamiento original es FULL. Si era Medium o Fast se cobra aparte, y su
 * precio no sale de ks_price_list: esa lista tiene tratamientos, no etapas
 * sueltas. Hasta que exista esa lista, el precio se declara acá.
 *
 * OJO: el valor es el costo TOTAL del caso de ese paciente. Alcanza mientras el
 * caso SEA la etapa adicional. El día que un paciente tenga en la caja el
 * tratamiento original Y una etapa adicional aparte, esto hay que partirlo en
 * dos.
 */
export const COSTO_ETAPA_ADICIONAL: Record<string, number> = {};

/** Plan declarado a mano cuando la caja no dice "cuota N de Y". */
export const PLAN_PACIENTE: Record<string, number> = {
  "hogner agustina": 7, "agustina hogner": 7,
};

// Precio TOTAL pactado con cada paciente — tabla pasada por Pancho el 24/8/26.
// La clave es el nombre (se normaliza con clavePaciente); las variantes de
// grafía de la caja se repiten para que el match no falle.
export const PRECIO_PACTADO: Record<string, number> = {
  "ponce sarahi": 3800000,
  "de donatis luz": 3626000, "de lonatis maria luz": 3626000,
  "russo sofia": 3800000,
  "herrera evelin": 4800000,
  "tonello fiorella": 3760000,
  "badiola ramiro": 3800000,
  "de frankerberg josefina": 3650000,
  "gallo gaston": 3900000,
  "lazaro magdalena": 3700000, "magui lazaro": 3700000,
  "daira castellon": 1200000,
  "szalontai natalia": 3800000,
  "agustina di natale": 3800000, "agustina di natale 39769016": 3800000,
  "tapia macarena": 3000000,
  "vicent patricia": 3800000,  // la tabla decía 380.000: typo confirmado por Pancho 24/8
};

/**
 * Descuento EXTRA sobre el costo KS del caso, en %, por paciente.
 *
 * Son casos con un descuento especial de KS: su tratamiento le cuesta al
 * consultorio un 16% menos que el de lista (Pancho, 25/8/26). Va sobre el costo
 * KS —lo que el consultorio le paga a la fábrica—, no sobre lo que paga el
 * paciente: el precio pactado con cada uno sigue siendo el de las tablas de
 * arriba.
 */
export const DESCUENTO_KS_ESPECIAL: Record<string, number> = {
  "nisenbaum martin": 16, "martin nissenbaum": 16, "nisenbaum": 16,
  "grillo catalina": 16,
  "etchegoyen ignacio": 16,
};

export const PRECIO_PACTADO_USD: Record<string, number> = {
  "botto agustina": 2800,
  "etchegoyen ignacio": 2250,
  "grillo catalina": 2250,
  "hogner agustina": 2800,     // paga en pesos al t/c de cada fila
  "nisenbaum martin": 2300, "martin nissenbaum": 2300, "nisenbaum": 2300,
  "de la torre guadalupe": 2700,
};

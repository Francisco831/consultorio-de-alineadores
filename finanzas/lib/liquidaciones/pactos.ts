// Lo que cada paciente pactó pagar, y las excepciones del costeo.
//
// Vivía dentro de scripts/liquidaciones.ts, que sólo corre en la terminal. Al
// poder recalcular desde el panel, la misma tabla la necesitan los dos: si se
// duplicara, el día que Pancho agregue un pacto acá y no allá el mismo cobro
// pasaría a costear distinto según quién apretó el botón.

/** Casos con etapa adicional incluida en el programa (1 a 4): no cargan costo. */
export const ETAPA_ADICIONAL = new Set(["cugat fernanda", "fernanda cugat"]);

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

export const PRECIO_PACTADO_USD: Record<string, number> = {
  "botto agustina": 2800,
  "etchegoyen ignacio": 2250,
  "grillo catalina": 2250,
  "hogner agustina": 2800,     // paga en pesos al t/c de cada fila
  "nisenbaum martin": 2300, "martin nissenbaum": 2300, "nisenbaum": 2300,
  "de la torre guadalupe": 2700,
};

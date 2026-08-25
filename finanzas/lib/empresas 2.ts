// Un solo lugar define todo lo que varía por empresa.
// Los componentes leen de acá; jamás hardcodean moneda, locale ni labels.

export type EmpresaSlug = "mx" | "ar";

export type EmpresaConfig = {
  slug: EmpresaSlug;
  nombre: string;
  pais: string;
  locale: string;
  timezone: string;
  /** Monedas operativas, en orden de importancia. NUNCA se convierten ni suman entre sí. */
  monedas: string[];
  monedaPrincipal: string;
  labelCostos: string;
};

export const EMPRESAS: Record<EmpresaSlug, EmpresaConfig> = {
  mx: {
    slug: "mx",
    nombre: "Keep Smiling México",
    pais: "México",
    locale: "es-MX",
    timezone: "America/Mexico_City",
    monedas: ["MXN"],
    monedaPrincipal: "MXN",
    labelCostos: "Costos de producción",
  },
  ar: {
    slug: "ar",
    nombre: "Consultorio Argentina",
    pais: "Argentina",
    locale: "es-AR",
    timezone: "America/Argentina/Buenos_Aires",
    monedas: ["ARS", "USD"],
    monedaPrincipal: "ARS",
    labelCostos: "Costos del consultorio",
  },
};

export function esEmpresaSlug(v: string): v is EmpresaSlug {
  return v === "mx" || v === "ar";
}

export const COOKIE_EMPRESA = "fin_empresa";

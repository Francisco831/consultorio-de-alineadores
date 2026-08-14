// Los números del mes, de UNA sola fuente.
//
// Antes cada pantalla los recalculaba en TypeScript —dashboard, hoy, pipeline y
// equipo, cinco reimplementaciones de la misma fórmula— mientras ai_forecast()
// hacía lo mismo en SQL. Las dos familias divergieron: las páginas se olvidaban
// de filtrar is_demo y de usar el huso de México, así que el tablero decía 19 de
// forecast mientras el asistente AI de la MISMA pantalla decía 6.
//
// Filtrar el demo en cada página arreglaba el número pero no la causa: dos
// implementaciones que coinciden por disciplina vuelven a divergir en la próxima
// métrica. Acá la fórmula vive en un solo lugar (0023) y las pantallas la leen.
//
// El chequeo 6 de scripts/security-checks.ts vigila exactamente esto.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ForecastMes {
  mes: string;
  /** Meta del país para el mes. Es de casos PAGADOS. */
  objetivo_casos_pagados: number | null;
  /** Casos que ENTRARON este mes (etapa I_1). Serie operativa, no el KPI. */
  casos_nuevos_mes: number;
  /** El KPI de verdad: pagos del mes en el ledger. */
  casos_pagados_mes_ledger: number;
  pipeline_ponderado: number;
  oportunidades_abiertas: number;
  /** casos_nuevos_mes + pipeline ponderado. Proyecta casos nuevos, no pagos. */
  forecast_casos_nuevos: number;
  /**
   * OJO con la semántica: es `objetivo_casos_pagados - forecast_casos_nuevos`, o
   * sea que compara la meta de pagados contra una proyección de casos nuevos —
   * la mezcla que la propia función desaconseja en sus `notas`. Se expone tal
   * como la calcula 0023 para no tener dos definiciones del gap, pero la UI lo
   * etiqueta por lo que es en vez de llamarlo "Gap" a secas.
   */
  gap_vs_objetivo: number | null;
  objetivo_acreditaciones: number | null;
  acreditados_mes: number;
  rows_considered: number;
  /** Aclaraciones de lectura que declara la propia función. */
  notas: string[];
  /** Lo que la función no pudo calcular (p. ej. objetivo sin cargar). */
  advertencias: string[];
}

/**
 * Lee los números del mes. `period` en formato YYYY-MM-01; sin él, el mes actual
 * en huso de México, que es el que resuelve la función.
 */
export async function getForecastMes(
  supabase: SupabaseClient,
  period?: string
): Promise<ForecastMes | null> {
  const { data, error } = await supabase.rpc("ai_forecast", {
    p_period: period ?? null,
  });
  if (error || !data) return null;
  return data as ForecastMes;
}

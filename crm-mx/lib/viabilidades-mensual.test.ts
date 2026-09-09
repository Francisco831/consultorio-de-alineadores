// El panel mensual dice, mes por mes, cuántas viabilidades entraron y cuántas
// convirtieron, contra el objetivo. Si el agrupado por mes se corre un día (el
// 1° cayendo en el mes anterior) o el estado del panel no es el de la tabla,
// Pancho compara contra un objetivo un número que no es. Estos casos fijan
// qué tiene que ver.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ViabilidadFila } from "./viabilidades";
import {
  contraObjetivo,
  esDelMes,
  mapaObjetivos,
  resumenMensual,
  tasaDe,
  totalMensual,
} from "./viabilidades-mensual";

// martes 15/9/26 a las 12:00 de México (18:00 UTC)
const AHORA = Date.parse("2026-09-15T18:00:00Z");
const MES_ACTUAL = "2026-09";

let n = 0;
function fila(p: Partial<ViabilidadFila> = {}): ViabilidadFila {
  n++;
  return {
    id: `v${n}`,
    stage: "viabilidad",
    patient_name: "Ana Torres",
    case_id: null,
    lost_reason: null,
    closed_at: null,
    created_at: "2026-09-01T15:00:00+00:00",
    stage_entered_at: null,
    // como lo guarda el formulario: medianoche UTC del día elegido
    viability_requested_at: "2026-09-01T00:00:00+00:00",
    viability_status: "solicitada",
    doctors: { id: "d1", nombre: "Dra. Hernández" },
    asesor: null,
    cases: null,
    ...p,
  };
}

const SIN_OBJETIVO = new Map<string, number>();

describe("resumenMensual", () => {
  it("agrupa por mes de ingreso y cuenta el estado de hoy", () => {
    const meses = resumenMensual(
      [
        // septiembre: una recién cargada y una que ya pasó la semana
        fila({ viability_requested_at: "2026-09-12T00:00:00+00:00" }),
        fila({ viability_requested_at: "2026-09-01T00:00:00+00:00" }),
        // agosto: una convirtió, una se suspendió
        fila({
          viability_requested_at: "2026-08-10T00:00:00+00:00",
          stage: "ganada",
          case_id: "c1",
        }),
        fila({
          viability_requested_at: "2026-08-20T00:00:00+00:00",
          stage: "perdida",
          lost_reason: "Viabilidad no convertida",
        }),
        // julio: sigue abierta hace dos meses
        fila({ viability_requested_at: "2026-07-01T00:00:00+00:00" }),
      ],
      SIN_OBJETIVO,
      MES_ACTUAL,
      AHORA
    );

    assert.deepEqual(
      meses.map((m) => m.mes),
      ["2026-09", "2026-08", "2026-07"],
      "del más nuevo al más viejo"
    );
    const [sep, ago, jul] = meses;
    assert.equal(sep.ingresadas, 2);
    assert.equal(sep.porEstado.esperando, 1);
    assert.equal(sep.porEstado.seguimiento, 1);
    assert.equal(sep.porEstado.convertida, 0);
    assert.equal(sep.tasa, 0);

    assert.equal(ago.ingresadas, 2);
    assert.equal(ago.porEstado.convertida, 1);
    assert.equal(ago.porEstado.suspendida, 1);
    assert.equal(ago.tasa, 50);

    assert.equal(jul.ingresadas, 1);
    assert.equal(jul.porEstado.seguimiento, 1);
    assert.equal(jul.tasa, 0);
  });

  it("la semana son siete días: el día 7 todavía espera, el 8 ya es seguimiento", () => {
    // pedido del 8/9: "hasta 7 días después de cargada" espera respuesta;
    // "superaron esos 7 días" pasa a seguimiento. El panel no decide esto
    // (es estadoDe, en lib/viabilidades.ts): acá se fija que lo respete.
    const meses = resumenMensual(
      [
        fila({ viability_requested_at: "2026-09-08T00:00:00+00:00" }), // 7 días
        fila({ viability_requested_at: "2026-09-07T00:00:00+00:00" }), // 8 días
      ],
      SIN_OBJETIVO,
      MES_ACTUAL,
      AHORA
    );
    assert.equal(meses[0].porEstado.esperando, 1);
    assert.equal(meses[0].porEstado.seguimiento, 1);
  });

  it("el 1° del mes cae en su mes, no en el anterior", () => {
    // 1/9 a medianoche UTC es 31/8 a la tarde en México: leído en México se
    // iría a agosto, y la viabilidad del 1° arrancaría el mes equivocado
    const meses = resumenMensual(
      [fila({ viability_requested_at: "2026-09-01T00:00:00+00:00" })],
      SIN_OBJETIVO,
      MES_ACTUAL,
      AHORA
    );
    assert.equal(meses.length, 1);
    assert.equal(meses[0].mes, "2026-09");
    assert.equal(meses[0].ingresadas, 1);
  });

  it("el mes en curso aparece aunque no tenga ninguna", () => {
    const meses = resumenMensual([], new Map([["2026-09", 60]]), MES_ACTUAL, AHORA);
    assert.equal(meses.length, 1);
    assert.deepEqual(meses[0], {
      mes: "2026-09",
      ingresadas: 0,
      porEstado: { esperando: 0, seguimiento: 0, suspendida: 0, convertida: 0 },
      tasa: null,
      objetivo: 60,
    });
  });

  it("el objetivo se pega por mes y falta como null", () => {
    const meses = resumenMensual(
      [
        fila({ viability_requested_at: "2026-08-10T00:00:00+00:00" }),
        fila({ viability_requested_at: "2026-07-10T00:00:00+00:00" }),
      ],
      mapaObjetivos([
        { period: "2026-08-01", target: 50 },
        { period: "2026-09-01", target: 60 },
      ]),
      MES_ACTUAL,
      AHORA
    );
    assert.deepEqual(
      meses.map((m) => [m.mes, m.objetivo]),
      [
        ["2026-09", 60],
        ["2026-08", 50],
        ["2026-07", null],
      ]
    );
  });

  it("una del import (sin fecha de pedido) cae en el mes en que entró a la etapa", () => {
    // las filas ya vienen filtradas por esViabilidad en la página; acá no se
    // vuelve a decidir qué es una viabilidad, solo en qué mes cae
    const meses = resumenMensual(
      [fila({ viability_requested_at: null, stage_entered_at: "2026-06-15T00:00:00+00:00" })],
      SIN_OBJETIVO,
      MES_ACTUAL,
      AHORA
    );
    assert.equal(meses.find((m) => m.mes === "2026-06")?.ingresadas, 1);
  });
});

describe("totalMensual", () => {
  it("suma los meses y calcula la conversión sobre el total", () => {
    const meses = resumenMensual(
      [
        fila({ viability_requested_at: "2026-08-10T00:00:00+00:00", stage: "ganada", case_id: "c1" }),
        fila({ viability_requested_at: "2026-08-12T00:00:00+00:00", stage: "ganada", case_id: "c2" }),
        fila({ viability_requested_at: "2026-07-10T00:00:00+00:00" }),
        fila({ viability_requested_at: "2026-09-12T00:00:00+00:00" }),
      ],
      SIN_OBJETIVO,
      MES_ACTUAL,
      AHORA
    );
    const t = totalMensual(meses);
    assert.equal(t.ingresadas, 4);
    assert.equal(t.porEstado.convertida, 2);
    assert.equal(t.porEstado.seguimiento, 1);
    assert.equal(t.porEstado.esperando, 1);
    assert.equal(t.tasa, 50);
  });

  it("sin viabilidades no hay tasa", () => {
    assert.equal(totalMensual([]).tasa, null);
    assert.equal(tasaDe(0, 0), null);
    assert.equal(tasaDe(1, 3), 33);
  });
});

describe("contraObjetivo", () => {
  it("cumple cuando llega al objetivo, y no hay veredicto sin objetivo o sin viabilidades", () => {
    assert.equal(contraObjetivo({ tasa: 60, objetivo: 60 }), "cumple");
    assert.equal(contraObjetivo({ tasa: 75, objetivo: 60 }), "cumple");
    assert.equal(contraObjetivo({ tasa: 59, objetivo: 60 }), "no_cumple");
    assert.equal(contraObjetivo({ tasa: 0, objetivo: 60 }), "no_cumple");
    assert.equal(contraObjetivo({ tasa: 80, objetivo: null }), null);
    assert.equal(contraObjetivo({ tasa: null, objetivo: 60 }), null);
  });
});

describe("esDelMes", () => {
  it("compara contra el mismo mes que usa el panel", () => {
    const o = fila({ viability_requested_at: "2026-09-01T00:00:00+00:00" });
    assert.equal(esDelMes(o, "2026-09"), true);
    assert.equal(esDelMes(o, "2026-08"), false);
  });
});

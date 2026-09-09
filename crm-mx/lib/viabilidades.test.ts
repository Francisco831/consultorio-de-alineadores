// La pestaña /viabilidades muestra tres cosas que se calculan y no se guardan:
// el estado (el equipo todavía está cerrando los nombres, por eso las etiquetas
// viven solas en ESTADOS), el número del mes y qué filas responden al buscador.
// Si algo de esto se corre, no explota: la tabla muestra otra cosa con toda
// naturalidad. Estos casos fijan lo que la asesora tiene que ver.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  coincide,
  esViabilidad,
  estadoDe,
  mesDe,
  numerar,
  type ViabilidadFila,
} from "./viabilidades";

// martes 8/9/26 a las 12:00 de México (18:00 UTC)
const AHORA = Date.parse("2026-09-08T18:00:00Z");

function fila(p: Partial<ViabilidadFila> = {}): ViabilidadFila {
  return {
    id: "a",
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

describe("estadoDe", () => {
  it("convertida: hay caso, aunque la fila siga en la etapa viabilidad", () => {
    assert.equal(estadoDe(fila({ case_id: "c1" }), AHORA), "convertida");
    assert.equal(estadoDe(fila({ stage: "ganada" }), AHORA), "convertida");
  });

  it("suspendida: se marcó perdida o el ciclo quedó sin respuesta", () => {
    assert.equal(estadoDe(fila({ stage: "perdida" }), AHORA), "suspendida");
    assert.equal(
      estadoDe(fila({ viability_status: "sin_respuesta" }), AHORA),
      "suspendida"
    );
  });

  it("abierta: esperando hasta el día 7 inclusive, seguimiento desde el 8", () => {
    const pedida = (fecha: string) =>
      fila({ viability_requested_at: `${fecha}T00:00:00+00:00` });
    assert.equal(estadoDe(pedida("2026-09-08"), AHORA), "esperando"); // hoy
    assert.equal(estadoDe(pedida("2026-09-01"), AHORA), "esperando"); // 7 días
    assert.equal(estadoDe(pedida("2026-08-31"), AHORA), "seguimiento"); // 8 días
    assert.equal(
      estadoDe(pedida("2026-08-31"), AHORA - 5 * 3_600_000),
      "seguimiento"
    );
  });

  it("respondida sin caso sigue abierta: la clasifica el reloj, no el ciclo", () => {
    assert.equal(
      estadoDe(
        fila({
          viability_status: "respondida",
          viability_requested_at: "2026-08-20T00:00:00+00:00",
        }),
        AHORA
      ),
      "seguimiento"
    );
  });

  it("el reloj arranca en la fecha de ingreso; sin ella, en la entrada a la etapa", () => {
    assert.equal(
      estadoDe(
        fila({
          viability_requested_at: null,
          stage_entered_at: "2026-08-20T00:00:00+00:00",
        }),
        AHORA
      ),
      "seguimiento"
    );
    assert.equal(
      estadoDe(
        fila({
          viability_requested_at: "2026-09-07T00:00:00+00:00",
          stage_entered_at: "2026-08-20T00:00:00+00:00",
        }),
        AHORA
      ),
      "esperando"
    );
  });
});

describe("numerar", () => {
  const pedida = (id: string, fecha: string, created = "2026-09-08T12:00:00Z") =>
    fila({ id, viability_requested_at: `${fecha}T00:00:00+00:00`, created_at: created });

  it("arranca de 1 cada mes y sigue el orden de ingreso, no el de la lista", () => {
    const n = numerar([
      pedida("c", "2026-09-03"),
      pedida("a", "2026-09-01"),
      pedida("e", "2026-10-02"),
      pedida("b", "2026-09-02"),
      pedida("d", "2026-10-01"),
    ]);
    assert.deepEqual(
      Object.fromEntries(n),
      { a: 1, b: 2, c: 3, d: 1, e: 2 }
    );
  });

  it("misma fecha de ingreso: la que se cargó antes va primero", () => {
    const n = numerar([
      pedida("tarde", "2026-09-05", "2026-09-05T20:00:00Z"),
      pedida("temprano", "2026-09-05", "2026-09-05T09:00:00Z"),
    ]);
    assert.equal(n.get("temprano"), 1);
    assert.equal(n.get("tarde"), 2);
  });

  it("una carga con fecha atrasada se mete en el medio y corre a las siguientes", () => {
    const antes = numerar([pedida("a", "2026-09-01"), pedida("c", "2026-09-03")]);
    assert.deepEqual(Object.fromEntries(antes), { a: 1, c: 2 });
    const despues = numerar([
      pedida("a", "2026-09-01"),
      pedida("c", "2026-09-03"),
      pedida("b", "2026-09-02"),
    ]);
    assert.deepEqual(Object.fromEntries(despues), { a: 1, b: 2, c: 3 });
  });

  it("el 1° del mes cae en su mes aunque en México todavía sea el mes anterior", () => {
    // medianoche UTC del 1/9 son las 18:00 del 31/8 en CDMX; el mes se lee en UTC
    assert.equal(mesDe("2026-09-01T00:00:00+00:00"), "2026-09");
    assert.equal(mesDe("2026-08-31T23:59:59+00:00"), "2026-08");
  });
});

describe("coincide", () => {
  it("ignora acentos y mayúsculas", () => {
    assert.ok(coincide("Dra. Hernández", "hernandez"));
    assert.ok(coincide("José Peña", "PEÑA"));
    assert.ok(coincide("Ana Torres", "  torres "));
  });

  it("vacío no filtra; sin texto no matchea", () => {
    assert.ok(coincide(null, ""));
    assert.ok(coincide("lo que sea", "   "));
    assert.equal(coincide(null, "ana"), false);
    assert.equal(coincide("Ana Torres", "lopez"), false);
  });
});

describe("esViabilidad", () => {
  it("la marca es la fecha de pedido; el resto es el criterio legacy del import", () => {
    assert.ok(esViabilidad(fila({ stage: "paciente_potencial" })));
    assert.ok(esViabilidad(fila({ viability_requested_at: null })));
    assert.ok(
      esViabilidad(
        fila({
          viability_requested_at: null,
          stage: "perdida",
          lost_reason: "Viabilidad no convertida",
        })
      )
    );
    assert.ok(
      esViabilidad(fila({ viability_requested_at: null, stage: "ganada", case_id: "c1" }))
    );
    assert.equal(
      esViabilidad(fila({ viability_requested_at: null, stage: "paciente_potencial" })),
      false
    );
    assert.equal(
      esViabilidad(fila({ viability_requested_at: null, stage: "ganada" })),
      false
    );
  });
});

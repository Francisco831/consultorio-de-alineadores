import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  atribuirCaso,
  contarCasosPorPersona,
  desdeConVentana,
  indiceDeToques,
} from "./atribucion";

const JUAN = "11111111-1111-1111-1111-111111111111";
const ROCIO = "22222222-2222-2222-2222-222222222222";
const DR = "dr-1";

describe("atribuirCaso", () => {
  test("el caso es de quien tocó último dentro de la ventana", () => {
    const idx = indiceDeToques([
      { doctor_id: DR, created_by: JUAN, occurred_at: "2026-06-01T10:00:00Z" },
      { doctor_id: DR, created_by: ROCIO, occurred_at: "2026-06-20T10:00:00Z" },
    ]);
    assert.equal(
      atribuirCaso({ doctor_id: DR, fecha_ingreso: "2026-07-01T00:00:00Z" }, idx),
      ROCIO
    );
  });

  test("un toque POSTERIOR al caso no se lleva el crédito", () => {
    const idx = indiceDeToques([
      { doctor_id: DR, created_by: JUAN, occurred_at: "2026-06-01T10:00:00Z" },
      { doctor_id: DR, created_by: ROCIO, occurred_at: "2026-07-15T10:00:00Z" },
    ]);
    assert.equal(
      atribuirCaso({ doctor_id: DR, fecha_ingreso: "2026-07-01T00:00:00Z" }, idx),
      JUAN
    );
  });

  test("fuera de la ventana el caso queda sin atribuir, no cae en el más viejo", () => {
    const idx = indiceDeToques([
      { doctor_id: DR, created_by: JUAN, occurred_at: "2026-01-01T10:00:00Z" },
    ]);
    assert.equal(
      atribuirCaso({ doctor_id: DR, fecha_ingreso: "2026-07-01T00:00:00Z" }, idx),
      null
    );
  });

  test("un doctor que nadie tocó queda sin atribuir", () => {
    assert.equal(
      atribuirCaso({ doctor_id: "otro", fecha_ingreso: "2026-07-01T00:00:00Z" }, new Map()),
      null
    );
  });

  test("sin autor no cuenta: las notas importadas no le dan crédito a nadie", () => {
    const idx = indiceDeToques([
      { doctor_id: DR, created_by: null, occurred_at: "2026-06-25T10:00:00Z" },
    ]);
    assert.equal(idx.size, 0);
  });
});

describe("contarCasosPorPersona", () => {
  test("atribuidos + sin atribuir = total (nunca se pierde ni se duplica un caso)", () => {
    const idx = indiceDeToques([
      { doctor_id: "a", created_by: JUAN, occurred_at: "2026-06-01T10:00:00Z" },
      { doctor_id: "b", created_by: ROCIO, occurred_at: "2026-06-05T10:00:00Z" },
    ]);
    const casos = [
      { doctor_id: "a", fecha_ingreso: "2026-06-10T00:00:00Z" },
      { doctor_id: "a", fecha_ingreso: "2026-06-20T00:00:00Z" },
      { doctor_id: "b", fecha_ingreso: "2026-06-15T00:00:00Z" },
      { doctor_id: "c", fecha_ingreso: "2026-06-15T00:00:00Z" },
    ];
    const { porPersona, sinAtribuir } = contarCasosPorPersona(casos, idx);
    assert.equal(porPersona.get(JUAN), 2);
    assert.equal(porPersona.get(ROCIO), 1);
    assert.equal(sinAtribuir, 1);
    const suma = [...porPersona.values()].reduce((a, b) => a + b, 0);
    assert.equal(suma + sinAtribuir, casos.length);
  });
});

describe("desdeConVentana", () => {
  test("corre el borde 90 días hacia atrás: un caso del día 1 puede venir de una visita anterior", () => {
    assert.equal(
      desdeConVentana("2026-09-01T00:00:00.000Z").slice(0, 10),
      "2026-06-03"
    );
  });
});

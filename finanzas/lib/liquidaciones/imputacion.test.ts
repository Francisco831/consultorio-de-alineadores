import { test } from "node:test";
import assert from "node:assert/strict";
import {
  doctoraDeLiquidacion, estaRevisado, estaCongelada, liquidacionesSinRespaldo,
  type Imputaciones,
} from "./imputacion";

const imp = (...filas: Array<[string, "caja" | "casa" | "profesional", string | null, boolean]>): Imputaciones =>
  new Map(filas.map(([id, destino, doctora, revisado]) => [id, { destino, doctora, revisado }]));

test("sin imputación manda la doctora de la caja", () => {
  assert.equal(doctoraDeLiquidacion("m1", "Mariana Franco", new Map()), "Mariana Franco");
});

test("imputar a otra doctora le gana a la caja", () => {
  assert.equal(
    doctoraDeLiquidacion("m1", "Mariana Franco", imp(["m1", "profesional", "Rocío Puig", true])),
    "Rocío Puig"
  );
});

test("destino 'casa' saca el cobro de toda liquidación", () => {
  // el caso que motivó todo: la paciente sólo retiró, la caja igual anotó
  // a la doctora que estaba en el consultorio
  const i = imp(["m1", "casa", null, true]);
  assert.equal(doctoraDeLiquidacion("m1", "Mariana Franco", i), null);
  assert.equal(doctoraDeLiquidacion("m2", "Mariana Franco", i), "Mariana Franco");
});

test("destino 'caja' liquida igual que no tener fila, pero deja constancia de que se miró", () => {
  const i = imp(["m1", "caja", null, true]);
  assert.equal(doctoraDeLiquidacion("m1", "Mónica González", i), "Mónica González");
  assert.equal(estaRevisado("m1", i), true);
  assert.equal(estaRevisado("m2", i), false);
});

test("un cobro sin doctora en la caja se puede asignar a mano", () => {
  assert.equal(
    doctoraDeLiquidacion("m9", null, imp(["m9", "profesional", "Mónica González", true])),
    "Mónica González"
  );
  assert.equal(doctoraDeLiquidacion("m8", null, new Map()), null);
});

test("revisar no cambia a quién se le liquida", () => {
  const sinRevisar = imp(["m1", "caja", null, false]);
  const revisado = imp(["m1", "caja", null, true]);
  assert.equal(
    doctoraDeLiquidacion("m1", "Virginia", sinRevisar),
    doctoraDeLiquidacion("m1", "Virginia", revisado)
  );
});

test("congelada es confirmada o pagada, no borrador ni anulada", () => {
  assert.equal(estaCongelada("confirmed"), true);
  assert.equal(estaCongelada("paid"), true);
  assert.equal(estaCongelada("draft"), false);
  assert.equal(estaCongelada("void"), false);   // anulada revive si vuelven sus cobros
});

test("la liquidación que se quedó sin cobros se anula", () => {
  const existentes = [
    { id: "s1", doctora: "Rocío Puig", periodo: "2026-07", status: "draft" },
    { id: "s2", doctora: "Mariana Franco", periodo: "2026-07", status: "draft" },
  ];
  const sinRespaldo = liquidacionesSinRespaldo(
    existentes, [{ doctora: "Mariana Franco", periodo: "2026-07" }], ["2026-07"]
  );
  assert.deepEqual(sinRespaldo.map((s) => s.id), ["s1"]);
});

test("no se tocan las de otros períodos ni las congeladas", () => {
  const existentes = [
    { id: "s1", doctora: "Rocío Puig", periodo: "2026-06", status: "draft" },   // fuera del alcance
    { id: "s2", doctora: "Eugenia Digiano", periodo: "2026-07", status: "paid" }, // congelada
    { id: "s3", doctora: "Virginia", periodo: "2026-07", status: "void" },      // ya anulada
    { id: "s4", doctora: "Coni", periodo: "2026-07", status: "draft" },
  ];
  const sinRespaldo = liquidacionesSinRespaldo(existentes, [], ["2026-07"]);
  assert.deepEqual(sinRespaldo.map((s) => s.id), ["s4"]);
});

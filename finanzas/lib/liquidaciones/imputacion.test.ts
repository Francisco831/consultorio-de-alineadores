import { test } from "node:test";
import assert from "node:assert/strict";
import { doctoraDeLiquidacion, estaCongelada, liquidacionesSinRespaldo } from "./imputacion";

test("sin imputación manda la doctora de la caja", () => {
  assert.equal(doctoraDeLiquidacion("m1", "Mariana Franco", new Map()), "Mariana Franco");
});

test("imputar a otra doctora le gana a la caja", () => {
  const imp = new Map([["m1", "Rocío Puig"]]);
  assert.equal(doctoraDeLiquidacion("m1", "Mariana Franco", imp), "Rocío Puig");
});

test("imputar a NADIE (null) no es lo mismo que no tener imputación", () => {
  // el caso que motivó todo: la paciente sólo retiró, la caja igual anotó
  // a la doctora que estaba en el consultorio
  const imp = new Map<string, string | null>([["m1", null]]);
  assert.equal(doctoraDeLiquidacion("m1", "Mariana Franco", imp), null);
  assert.equal(doctoraDeLiquidacion("m2", "Mariana Franco", imp), "Mariana Franco");
});

test("un cobro sin doctora en la caja se puede asignar a mano", () => {
  const imp = new Map([["m9", "Mónica González"]]);
  assert.equal(doctoraDeLiquidacion("m9", null, imp), "Mónica González");
  assert.equal(doctoraDeLiquidacion("m8", null, new Map()), null);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, parseAmount, parseDateDDMM, daysBetween } from "./normalize";

test("norm: lower + sin acentos", () => {
  assert.equal(norm("Contención"), "contencion");
  assert.equal(norm("  MÓNICA GONZÁLEZ "), "monica gonzalez");
});

test("parseAmount: rechaza texto con letras (CUIT bajo columna corrida)", () => {
  // regresión: strippear letras y concatenar dígitos fabricaba montos de
  // miles de millones con las filas corridas de Banco_ABR26/MAY26
  assert.equal(parseAmount("SF BADIOLA/R 20410718554 VAR VARIOS 0041"), null);
  assert.equal(parseAmount("VAR TRANSFERENCIA"), null);
  // tokens de moneda sí se permiten
  assert.equal(parseAmount("USD 400"), 400);
  assert.equal(parseAmount("$ 152.430"), 152430);
});

test("parseAmount: formatos reales", () => {
  assert.equal(parseAmount("1.711.272,40"), 1711272.4);
  assert.equal(parseAmount("175000"), 175000);
  assert.equal(parseAmount(30000), 30000);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(""), null);
});

test("parseDateDDMM: ISO con hora (como vienen las hojas Macro)", () => {
  assert.equal(parseDateDDMM("2026-03-25 00:00:00"), "2026-03-25");
});

test("parseDateDDMM: DD/MM/YYYY fijo, jamás MM/DD", () => {
  assert.equal(parseDateDDMM("05/03/2026"), "2026-03-05");
  assert.equal(parseDateDDMM("25/12/26"), "2026-12-25");
  assert.equal(parseDateDDMM("13/13/2026"), null);
});

test("parseDateDDMM: serial de Excel", () => {
  assert.equal(parseDateDDMM(46106), "2026-03-25");
});

test("daysBetween", () => {
  assert.equal(daysBetween("2026-07-01", "2026-07-05"), 4);
});

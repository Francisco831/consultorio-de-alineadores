import { test } from "node:test";
import assert from "node:assert/strict";
import { matchear, nameScore, similarity, tokens } from "./matcher";
import type { LineaExtracto, MovimientoCandidato } from "./matcher";

function linea(id: string, fecha: string, monto: number, nombre: string): LineaExtracto {
  return { id, fecha, monto, nombre };
}
function mov(id: string, fecha: string, monto: number, nombre: string): MovimientoCandidato {
  return { id, fecha, monto, nombre };
}

test("similarity: tolerancia a typos (equivalente al ratio ≥0.8 de difflib)", () => {
  assert.ok(similarity("gonzalez", "gonzales") >= 0.8);
  assert.ok(similarity("martinez", "lopez") < 0.8);
});

test("tokens: saca stopwords, cortos y números (igual que el original)", () => {
  assert.deepEqual([...tokens("Maria Jose de la Cruz DNI 12345678")], ["cruz"]);
});

test("nameScore: caso real Lindsell ↔ Fernandez Lindsell", () => {
  assert.ok(nameScore("Lindsell", "Fernandez Lindsell") >= 0.5);
});

test("pasada 1: nombre + monto + fecha ±4d", () => {
  const r = matchear(
    [linea("l1", "2026-07-10", 200000, "Sofia Maria Navar")],
    [mov("m1", "2026-07-08", 200000, "Navar Sofia"), mov("m2", "2026-07-08", 200000, "Perez Juan")]
  );
  assert.equal(r.sugerencias.length, 1);
  assert.deepEqual(r.sugerencias[0].movementIds, ["m1"]);
  assert.equal(r.sugerencias[0].method, "nombre_monto_fecha");
});

test("pasada 2: agrupado — un cobro MP = 2 cuotas de la planilla", () => {
  const r = matchear(
    [linea("l1", "2026-07-10", 300000, "Gallo Maria Dolores")],
    [
      mov("m1", "2026-06-20", 100000, "Gallo Dolores"),
      mov("m2", "2026-07-05", 200000, "Gallo Dolores"),
    ]
  );
  assert.equal(r.sugerencias.length, 1);
  assert.equal(r.sugerencias[0].method, "agrupado");
  assert.equal(r.sugerencias[0].movementIds.length, 2);
});

test("pasada 3: monto+fecha candidato único aunque el pagador no matchee", () => {
  const r = matchear(
    [linea("l1", "2026-07-10", 152430, "RODRIGUEZ CARLOS (padre)")],
    [mov("m1", "2026-07-09", 152430, "Rodriguez Valentina")]
  );
  assert.equal(r.sugerencias.length, 1);
  assert.ok(["nombre_monto_fecha", "monto_unico", "sobrante_mutuo"].includes(r.sugerencias[0].method));
});

test("caso Badiola: dos transferencias del banco cierran contra UN cobro de la caja", () => {
  // el banco tiene 400.000 + 234.000 el 27/3; la caja lo anotó como 634.000
  const r = matchear(
    [linea("l1", "2026-03-27", 400000, "BADIOLA RAMIRO"),
     linea("l2", "2026-03-27", 234000, "BADIOLA RAMIRO")],
    [mov("m1", "2026-03-27", 634000, "Badiola Ramiro")]
  );
  assert.equal(r.sugerencias.length, 2, "las dos líneas quedan sugeridas");
  assert.ok(r.sugerencias.every((s) => s.method === "lineas_agrupadas"));
  assert.ok(r.sugerencias.every((s) => s.movementIds[0] === "m1"));
  assert.equal(r.lineasSinMatch.length, 0);
});

test("no agrupa líneas si el nombre no coincide", () => {
  const r = matchear(
    [linea("l1", "2026-03-27", 400000, "PEREZ ANA"),
     linea("l2", "2026-03-27", 234000, "GOMEZ LUIS")],
    [mov("m1", "2026-03-27", 634000, "Badiola Ramiro")]
  );
  assert.equal(r.sugerencias.length, 0);
  assert.equal(r.lineasSinMatch.length, 2);
});

test("sin match → no_identificado", () => {
  const r = matchear(
    [linea("l1", "2026-07-10", 999999, "Desconocido Total")],
    [mov("m1", "2026-07-09", 152430, "Rodriguez Valentina")]
  );
  assert.equal(r.sugerencias.length, 0);
  assert.deepEqual(r.lineasSinMatch, ["l1"]);
});

test("pasada 0: external_key gana a todo", () => {
  const r = matchear(
    [{ ...linea("l1", "2026-07-10", 100, "X"), externalKey: "mp:123" }],
    [{ ...mov("m1", "2026-01-01", 999, "Otro"), externalKey: "mp:123" }]
  );
  assert.equal(r.sugerencias[0].method, "external_key");
});

test("dos líneas idénticas no se pisan un mismo movimiento", () => {
  const r = matchear(
    [linea("l1", "2026-07-10", 30000, "Perez Ana"), linea("l2", "2026-07-10", 30000, "Perez Ana")],
    [mov("m1", "2026-07-10", 30000, "Perez Ana")]
  );
  assert.equal(r.sugerencias.length, 1);
  assert.equal(r.lineasSinMatch.length, 1);
});

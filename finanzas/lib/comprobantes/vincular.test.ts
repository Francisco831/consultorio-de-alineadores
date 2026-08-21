import { test } from "node:test";
import assert from "node:assert/strict";
import { fechaDeCarpeta, vincular, type ArchivoDrive, type MovIngreso } from "./vincular";

const archivo = (over: Partial<ArchivoDrive>): ArchivoDrive => ({
  id: "f1", title: "Gallo Gastón", parent: "c1", mime: "image/jpeg",
  url: "https://drive/x", created: null, ...over,
});
const mov = (over: Partial<MovIngreso>): MovIngreso => ({
  id: "m1", occurred_on: "2026-08-19", paciente: "Gallo Gastón", pacienteKey: "cp-gallo", ...over,
});
const CARPETAS = [{ id: "c1", title: "19-8-26" }];

test("fechaDeCarpeta parsea D-M-YY y variantes con cero", () => {
  assert.equal(fechaDeCarpeta("19-8-26"), "2026-08-19");
  assert.equal(fechaDeCarpeta("05-12-26"), "2026-12-05");
  assert.equal(fechaDeCarpeta("Comprobantes viejos"), null);
  assert.equal(fechaDeCarpeta("40-8-26"), null);
});

test("matchea mismo día por nombre aunque cambie orden y mayúsculas", () => {
  const r = vincular([archivo({ title: "GASTON GALLO" })], CARPETAS, [mov({})]);
  assert.equal(r.vinculos.length, 1);
  assert.deepEqual(r.vinculos[0].movementIds, ["m1"]);
  assert.equal(r.vinculos[0].corrimiento, 0);
});

test("el nombre del archivo puede ser subset del nombre en caja", () => {
  const r = vincular(
    [archivo({ title: "Flesch Roxana" })],
    CARPETAS,
    [mov({ paciente: "Flesch Roxana no hacer factura, factura Moni", pacienteKey: "cp-flesch" })]
  );
  assert.equal(r.vinculos.length, 1);
});

test("un comprobante cubre todos los ingresos del paciente ese día", () => {
  const r = vincular([archivo({})], CARPETAS, [mov({}), mov({ id: "m2" })]);
  assert.deepEqual(r.vinculos[0].movementIds.sort(), ["m1", "m2"]);
});

test("si no hay fila ese día busca hasta ±3 días y reporta el corrimiento", () => {
  // la caja llega hasta el 25/8: la carpeta del 19/8 ya está consolidada
  const r = vincular([archivo({})], CARPETAS, [
    mov({ occurred_on: "2026-08-21" }),
    mov({ id: "m9", occurred_on: "2026-08-25", paciente: "Otra Persona", pacienteKey: "z" }),
  ]);
  assert.equal(r.vinculos.length, 1);
  assert.equal(r.vinculos[0].corrimiento, 2);
});

test("comprobante sin fila en caja queda en sinMatch", () => {
  const r = vincular([archivo({ title: "Perez Juan" })], CARPETAS, [mov({})]);
  assert.equal(r.vinculos.length, 0);
  assert.equal(r.sinMatch.length, 1);
  assert.equal(r.sinMatch[0].carpeta, "19-8-26");
});

test("dos pacientes distintos que matchean el mismo día = ambiguo, no vincula", () => {
  const r = vincular(
    [archivo({ title: "Gimenez" })],
    CARPETAS,
    [mov({ paciente: "Gimenez Milagros", pacienteKey: "a" }), mov({ id: "m2", paciente: "Gimenez Carla", pacienteKey: "b" })]
  );
  assert.equal(r.vinculos.length, 0);
  assert.equal(r.ambiguos.length, 1);
});

test("archivo cuyo parent no es carpeta diaria queda aparte", () => {
  const r = vincular([archivo({ parent: "otra" })], CARPETAS, [mov({})]);
  assert.equal(r.fueraDeCarpeta.length, 1);
});

test("carpetas con barras y títulos con extensión adentro", () => {
  assert.equal(fechaDeCarpeta("3/7/26"), "2026-07-03");
  assert.equal(fechaDeCarpeta("9-6-26 "), "2026-06-09");
  const r = vincular(
    [archivo({ title: "Morabito Romina.jpeg" })],
    [{ id: "c1", title: "3/7/26" }],
    [mov({ paciente: "Morabito Romina", occurred_on: "2026-07-03" })]
  );
  assert.equal(r.vinculos.length, 1);
});

test("comprobante que nombra a dos pacientes vincula a los dos", () => {
  const r = vincular(
    [archivo({ title: "Grillo Catalina e Ignacio Etchegoyen" })],
    CARPETAS,
    [mov({ paciente: "Grillo Catalina", pacienteKey: "a" }), mov({ id: "m2", paciente: "Etchegoyen Ignacio", pacienteKey: "b" })]
  );
  assert.equal(r.vinculos.length, 1);
  assert.deepEqual(r.vinculos[0].movementIds.sort(), ["m1", "m2"]);
});

test("mismo paciente con nombre invertido (misma clave) no es ambiguo", () => {
  const r = vincular(
    [archivo({ title: "Botto Agustina..jpeg" })],
    CARPETAS,
    [mov({ paciente: "Agustina Botto", pacienteKey: "agustina botto" }), mov({ id: "m2", paciente: "Botto Agustina", pacienteKey: "agustina botto" })]
  );
  assert.equal(r.vinculos.length, 1);
  assert.deepEqual(r.vinculos[0].movementIds.sort(), ["m1", "m2"]);
});

test("carpeta posterior al último día cargado NO busca hacia atrás", () => {
  const r = vincular(
    [archivo({ parent: "c2" })],
    [...CARPETAS, { id: "c2", title: "21-8-26" }],
    [mov({})] // último día cargado: 19/8
  );
  assert.equal(r.vinculos.length, 0);
  assert.equal(r.sinMatch.length, 1);
});

test("si la carpeta no matchea, prueba la fecha de subida del archivo", () => {
  const r = vincular(
    [archivo({ parent: "c1", created: "2026-07-23T14:00:00.000Z" })],
    [{ id: "c1", title: "16-6-26" }],
    [mov({ occurred_on: "2026-07-23" }), mov({ id: "m2", occurred_on: "2026-08-19", paciente: "Otro Paciente", pacienteKey: "x" })]
  );
  assert.equal(r.vinculos.length, 1);
  assert.equal(r.vinculos[0].via, "subida");
  assert.deepEqual(r.vinculos[0].movementIds, ["m1"]);
});

test("en la ventana reciente (caja aún incompleta) no hay corrimiento", () => {
  // caja cargada hasta el 21/8; comprobante del 21/8 de un paciente que pagó
  // el 19/8: NO debe colgarse de ese pago viejo
  const r = vincular(
    [archivo({ parent: "c2" })],
    [...CARPETAS, { id: "c2", title: "21-8-26" }],
    [mov({ occurred_on: "2026-08-19" }), mov({ id: "m2", occurred_on: "2026-08-21", paciente: "Otra Persona", pacienteKey: "z" })]
  );
  assert.equal(r.vinculos.length, 0);
  assert.equal(r.sinMatch.length, 1);
});

test("huérfano con typo fuerte propone el candidato del día (posible)", () => {
  const r = vincular(
    [archivo({ title: "Slavustky Santiago .jpeg" })],
    CARPETAS,
    [
      mov({ paciente: "Slavutsky Santiago", pacienteKey: "slav" }),
      mov({ id: "m2", occurred_on: "2026-08-25", paciente: "Otra Persona", pacienteKey: "z" }),
    ]
  );
  assert.equal(r.vinculos.length, 0);
  assert.equal(r.sinMatch[0].motivo, "sin_fila");
  assert.ok(r.sinMatch[0].posible);
  assert.equal(r.sinMatch[0].posible!.paciente, "Slavutsky Santiago");
  assert.deepEqual(r.sinMatch[0].posible!.movementIds, ["m1"]);
});

test("huérfano reciente se marca caja_reciente y sin posible", () => {
  const r = vincular(
    [archivo({ parent: "c2", title: "Nadie Conocido" })],
    [...CARPETAS, { id: "c2", title: "21-8-26" }],
    [mov({ occurred_on: "2026-08-21" })]
  );
  assert.equal(r.sinMatch[0].motivo, "caja_reciente");
  assert.equal(r.sinMatch[0].posible, undefined);
});

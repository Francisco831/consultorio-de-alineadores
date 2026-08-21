import { test } from "node:test";
import assert from "node:assert/strict";
import { extraerFilasSolicitud, faltantesSolicitud } from "./solicitud";

const GRID: (string | number | null)[][] = [
  ["No hacer factura", "6/26", "2026-06-10", "TR Mp", "Monica Gonzalez", "Zaietz Luna", 35000, "junio"],
  ["No hacer factura", "6/26", "2026-06-10", "TR Mp", "Monica Gonzalez", "De Souza Marcelo", 200000, "contenciones"],
  ["encabezado sin monto", null, null],
  ["CUIT como número gigante", "2026-08-05", 20228873064, "Lázaro Magdalena"],
];

test("extrae filas 2026 con monto y descarta CUITs disfrazados de monto", () => {
  const filas = extraerFilasSolicitud(GRID);
  assert.equal(filas.length, 2);
  assert.deepEqual(filas.map((f) => f.monto), [35000, 200000]);
  assert.equal(filas[0].fecha, "2026-06-10");
});

test("faltantes: detecta la fila sin caja e ignora doctoras y rótulos", () => {
  const filas = extraerFilasSolicitud(GRID);
  const movs = [{ occurred_on: "2026-06-10", nombre: "Luna Zaietz" }];
  const r = faltantesSolicitud(filas, movs);
  assert.equal(r.cruzadas, 2);
  assert.equal(r.faltan.length, 1);
  assert.deepEqual(r.faltan[0].nombres, ["De Souza Marcelo"]);
});

test("nombre con typo dentro de ±5 días cuenta como presente", () => {
  const filas = extraerFilasSolicitud([["2026-06-10", "Monica Gonzalez", "Slavutsky Santiago", 35000]]);
  const r = faltantesSolicitud(filas, [{ occurred_on: "2026-06-12", nombre: "Slavustky Santiago" }]);
  assert.equal(r.faltan.length, 0);
});

test("los rótulos (bancos, billeteras) no cuentan como paciente", () => {
  const filas = extraerFilasSolicitud([["2026-05-06", "MERCADO PAGO", 70000]]);
  const r = faltantesSolicitud(filas, []);
  assert.equal(r.cruzadas, 0);
  assert.equal(r.faltan.length, 0);
});

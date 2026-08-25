import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmbito, tablaTC, tcDe, urlAmbito } from "./fx";

// Respuesta real de Ámbito (recortada) del 25/8/2026: encabezado, un día
// repetido (24/07 publica dos veces) y separador decimal con coma.
const AMBITO = [
  ["Fecha", "Compra", "Venta"],
  ["30/07/2026", "1550,00", "1570,00"],
  ["24/07/2026", "1525,00", "1545,00"],
  ["24/07/2026", "1540,00", "1560,00"],
  ["10/07/2026", "1500,00", "1520,00"],
];

test("el t/c es el punto medio entre comprador y vendedor", () => {
  assert.equal(tcDe({ compra: 1500, venta: 1520 }), 1510);
});

test("Ámbito: se descarta el encabezado y del día repetido vale el cierre", () => {
  const c = parseAmbito(AMBITO);
  assert.deepEqual(c.map((x) => x.fecha), ["2026-07-10", "2026-07-24", "2026-07-30"]);
  // de los dos 24/07 queda el PRIMERO del feed (el más reciente = cierre)
  assert.deepEqual(c.find((x) => x.fecha === "2026-07-24"), {
    fecha: "2026-07-24", compra: 1525, venta: 1545,
  });
});

test("Ámbito: miles con punto y decimales con coma", () => {
  const [c] = parseAmbito([["Fecha", "Compra", "Venta"], ["10/07/2026", "1.500,50", "1.520,00"]]);
  assert.equal(c.compra, 1500.5);
  assert.equal(tcDe(c), 1510.25);
});

test("Ámbito: una respuesta sin cotizaciones es un error, no una tabla vacía", () => {
  assert.throws(() => parseAmbito([["Fecha", "Compra", "Venta"]]), /ninguna cotización/);
  assert.throws(() => parseAmbito({ error: "boom" }), /no es una lista/);
});

test("la URL del histórico va en dd-mm-yyyy", () => {
  assert.match(urlAmbito("2026-07-01", "2026-07-31"), /historico-general\/01-07-2026\/31-07-2026$/);
});

test("un día sin rueda arrastra la última cotización anterior", () => {
  const tc = tablaTC(parseAmbito(AMBITO));
  assert.equal(tc("2026-07-10"), 1510);
  // 12/07/2026 es domingo: vale el t/c del viernes 10
  assert.equal(tc("2026-07-12"), 1510);
  assert.equal(tc.fechaUsada("2026-07-12"), "2026-07-10");
});

test("antes de la primera cotización no se inventa un t/c", () => {
  const tc = tablaTC(parseAmbito(AMBITO));
  assert.equal(tc("2026-06-30"), undefined);
  assert.equal(tc.fechaUsada("2026-06-30"), undefined);
});

test("caso Nisenbaum: el 10/07 el blue promedio da los 1510 de la planilla", () => {
  const tc = tablaTC(parseAmbito(AMBITO));
  assert.equal(tc("2026-07-10"), 1510);
});

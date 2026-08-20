import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMacroSheet } from "./parse-macro";

// Fixtures calcados de las hojas reales de 2026_Consultorio.xlsx.

const MAR26: (string | null)[][] = [
  [null, null, null, null, null, null, "0", "2009000", null, null, null, null],
  ["Fecha", "BANCO", "PROFESIONAL", "PACIENTE", "FACTURADOR", "NRO DE FC", "TOTAL FACTURA USD", "IMPORTE", null, "Fecha REAL", "Fecha Valor", "DETALLE"],
  ["2026-03-25 00:00:00", "MACRO", "GONZALEZ MONICA", "RENDAL ANGELES", "SIN FACTURA", "CONSULTORIO- CONSULTA", null, "30000", null, "2026-03-25 00:00:00", null, null],
  ["2026-03-25 00:00:00", "MACRO", "GONZALEZ MONICA", "FERRANDO MARIANA", "SIN FACTURA", "CONSULTORIO CONTENCIONES", null, "110000", null, "2026-03-25 00:00:00", null, null],
];

const MAY26: (string | null)[][] = [
  [null, null, null, null, null, "0", "2519000", null, null, null, null, null],
  ["Fecha", "BANCO", "PROFESIONAL", "PACIENTE", "NRO DE FC", "TOTAL FACTURA USD", "IMPORTE", null, "FECHA CONFIG", "Fecha REAL", "Fecha Valor", "DETALLE"],
  ["2026-05-04 00:00:00", "MACRO $", "FRANCO MARIANA", "OLMOS MAGDALENA", "A - 00004-00020664", null, "175000", null, "2026-05-04 00:00:00", "2026-05-04 00:00:00", "154287", "328"],
  ["2026-05-05 00:00:00", "MACRO $", "FRANCO MARIANA", "BALBOA HERNAN", "CONSULTORIO CONSULTA", null, "60000", null, "2026-05-05 00:00:00", "2026-05-05 00:00:00", "622916", "328"],
];

test("MAR26: header en fila 2, columnas con FACTURADOR", () => {
  const r = parseMacroSheet(MAR26);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].fecha, "2026-03-25");
  assert.equal(r.lines[0].amount, 30000);
  assert.equal(r.lines[0].contraparte, "RENDAL ANGELES");
  // "NRO DE FC" traía el concepto, no una factura
  assert.equal(r.lines[0].nroFactura, null);
  assert.equal(r.lines[0].descripcion, "CONSULTORIO- CONSULTA");
});

test("MAY26: columnas distintas (sin FACTURADOR) + factura real detectada", () => {
  const r = parseMacroSheet(MAY26);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].amount, 175000);
  assert.equal(r.lines[0].nroFactura, "A - 00004-00020664");
  assert.equal(r.lines[1].nroFactura, null);
  assert.equal(r.lines[1].descripcion, "CONSULTORIO CONSULTA");
});

test("fila corrida una columna se recupera con offset", () => {
  const shifted = [
    MAY26[0], MAY26[1],
    // toda la fila corrida +1 (celda 0 vacía)
    [null, "2026-05-06 00:00:00", "MACRO $", "FRANCO MARIANA", "PEREZ JOSE", "CONSULTORIO CONSULTA", null, "90000", null, null, null, null],
  ];
  const r = parseMacroSheet(shifted);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].fecha, "2026-05-06");
  assert.equal(r.lines[0].amount, 90000);
});

test("regresión ABR26: CUIT bajo 'Débito' NO se toma como monto (IMPORTE manda)", () => {
  const rows = [
    MAY26[0],
    ["Fecha", "BANCO", "PROFESIONAL", "PACIENTE", "NRO DE FC", "TOTAL FACTURA USD", "IMPORTE", null, "FECHA CONFIG", "Fecha REAL", "Credito", "Débito"],
    // fila real corrida: el texto+CUIT cae bajo Credito/Débito, IMPORTE es el bueno
    ["2026-04-13 00:00:00", "MACRO $", "GONZALEZ MONICA", "PISTONE PAULA", "CONSULTORIO CONSULTA", null, "35000", null, null, null, "SF PISTONE/R 27280337531 VAR VARIOS", null],
  ];
  const r = parseMacroSheet(rows);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].amount, 35000);
});

test("fila BBVA USD: monto sale de TOTAL FACTURA USD con currency USD", () => {
  const rows = [
    MAY26[0], MAY26[1],
    ["2026-04-22 00:00:00", "BBVA USD", "FRANCO MARIANA", "PEREZ VIVIANA", "SIN FACTURA", "400", null, null, null, null, null, null],
  ];
  const r = parseMacroSheet(rows);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].currency, "USD");
  assert.equal(r.lines[0].amount, 400);
  assert.equal(r.lines[0].banco, "BBVA USD");
});

test("controlTotal se lee de la fila previa al header", () => {
  const r = parseMacroSheet(MAY26);
  assert.equal(r.controlTotal, 2519000);
});

test("fila ilegible va a skipped, no revienta", () => {
  const bad = [MAY26[0], MAY26[1], ["basura", "x", "y", "z", null, null, "no-numero", null, null, null, null, null]];
  const r = parseMacroSheet(bad);
  assert.equal(r.lines.length, 0);
  assert.equal(r.skipped.length, 1);
});

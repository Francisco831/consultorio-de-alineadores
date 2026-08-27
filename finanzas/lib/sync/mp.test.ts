import { test } from "node:test";
import assert from "node:assert/strict";
import { offsetDe, sumarDias } from "./mp";

// MP interpreta las fechas en la zona de la CUENTA y las redondea al día.
// Mandarle medianoche UTC hace que en Argentina el reporte arranque el día
// anterior — que es como se pisaban las líneas ya cargadas a mano.
test("offsetDe: la zona de la cuenta, no UTC", () => {
  assert.equal(offsetDe("America/Argentina/Buenos_Aires", "2026-08-27"), "-03:00");
  assert.equal(offsetDe("America/Mexico_City", "2026-08-27"), "-06:00");
  assert.equal(offsetDe("UTC", "2026-08-27"), "+00:00");
});

test("offsetDe: sigue el horario de verano de la cuenta", () => {
  // México no tiene DST desde 2022; Nueva York sí, y sirve de control
  assert.equal(offsetDe("America/New_York", "2026-01-15"), "-05:00");
  assert.equal(offsetDe("America/New_York", "2026-07-15"), "-04:00");
});

test("sumarDias cruza fin de mes y de año", () => {
  assert.equal(sumarDias("2026-08-27", -1), "2026-08-26");
  assert.equal(sumarDias("2026-09-01", -1), "2026-08-31");
  assert.equal(sumarDias("2026-01-01", -1), "2025-12-31");
  assert.equal(sumarDias("2026-03-01", -1), "2026-02-28");
  assert.equal(sumarDias("2026-08-27", 0), "2026-08-27");
});

// El bug que hacía que el reporte arrancara un día antes y pisara lo cargado
// a mano: medianoche UTC pelada cae a las 21:00 del día anterior en Argentina.
// Y MP exige la hora exacta T00:00:00Z, así que hay que correr el DÍA.
import { diaZParaDiaLocal } from "./mp";

const diaEn = (tz: string, z: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(z));

test("diaZParaDiaLocal: la medianoche Z que cae en el día local pedido", () => {
  const ar = "America/Argentina/Buenos_Aires";
  assert.equal(diaZParaDiaLocal("2026-08-22", ar), "2026-08-23");
  assert.equal(diaEn(ar, `${diaZParaDiaLocal("2026-08-22", ar)}T00:00:00Z`), "2026-08-22");
  // el bug viejo: mandar el mismo día caía en el anterior
  assert.equal(diaEn(ar, "2026-08-22T00:00:00Z"), "2026-08-21");
});

test("diaZParaDiaLocal: sirve para México y para UTC", () => {
  const mx = "America/Mexico_City";
  assert.equal(diaEn(mx, `${diaZParaDiaLocal("2026-08-22", mx)}T00:00:00Z`), "2026-08-22");
  assert.equal(diaZParaDiaLocal("2026-08-22", "UTC"), "2026-08-22");
});

test("diaZParaDiaLocal: al este de Greenwich no hace falta correr nada", () => {
  // con offset positivo la medianoche Z ya cae en el mismo día local (09:00 en
  // Tokio), así que el día pedido es el que se manda. El corrimiento es sólo
  // un problema al oeste, que es donde están las dos empresas.
  const tk = "Asia/Tokyo";
  assert.equal(diaZParaDiaLocal("2026-08-22", tk), "2026-08-22");
  assert.equal(diaEn(tk, `${diaZParaDiaLocal("2026-08-22", tk)}T00:00:00Z`), "2026-08-22");
});

test("diaZParaDiaLocal: cruza fin de mes", () => {
  const ar = "America/Argentina/Buenos_Aires";
  assert.equal(diaZParaDiaLocal("2026-08-31", ar), "2026-09-01");
  assert.equal(diaEn(ar, `${diaZParaDiaLocal("2026-08-31", ar)}T00:00:00Z`), "2026-08-31");
});

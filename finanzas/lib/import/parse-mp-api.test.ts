import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMpApiCsv } from "./parse-mp-api";

const CSV = [
  "DATE,SOURCE_ID,EXTERNAL_REFERENCE,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT",
  "2026-08-01T00:00:00.000-06:00,,,initial_available_balance,,1500.00,0.00",
  "2026-08-02T10:15:00.000-06:00,118250001001,,release,payment,980.50,0.00",
  '2026-08-03T09:00:00.000-06:00,118250001002,,release,"payout, retiro a banco",0.00,900.00',
  "2026-08-03T09:00:00.000-06:00,,,release,mp_fee,0.00,12.30",
  "2026-08-04T00:00:00.000-06:00,,,total,,1568.20,0.00",
].join("\n");

describe("parseMpApiCsv", () => {
  it("separa movimientos release de los saldos de control", () => {
    const r = parseMpApiCsv(CSV);
    assert.equal(r.movimientos.length, 3);
    assert.equal(r.control.inicial, 1500);
    assert.equal(r.control.final, 1568.2);
  });

  it("firma créditos positivos y débitos negativos, con comillas y comas", () => {
    const [pago, retiro, fee] = parseMpApiCsv(CSV).movimientos;
    assert.equal(pago.fecha, "2026-08-02");
    assert.equal(pago.monto, 980.5);
    assert.equal(pago.source_id, "118250001001");
    assert.equal(retiro.monto, -900);
    assert.equal(retiro.descripcion, "payout, retiro a banco");
    assert.equal(fee.monto, -12.3);
    assert.equal(fee.source_id, null);
  });

  it("acepta el mismo reporte con punto y coma", () => {
    const conPyC = CSV.split("\n")
      .map((l) => l.replace(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ";"))
      .join("\n");
    const r = parseMpApiCsv(conPyC);
    assert.equal(r.movimientos.length, 3);
    assert.equal(r.movimientos[0].monto, 980.5);
  });

  it("explota claro si el CSV no es un reporte de liberaciones", () => {
    assert.throws(() => parseMpApiCsv("A,B,C\n1,2,3"), /DATE\/RECORD_TYPE/);
  });
});

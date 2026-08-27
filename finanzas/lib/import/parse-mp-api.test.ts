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

  // RECORD_TYPE dejó de ser obligatoria: el reporte de Argentina no la trae.
  // DATE sí, y es lo único sin lo cual el archivo no se puede leer.
  it("explota claro si el CSV no es un reporte de liberaciones", () => {
    assert.throws(() => parseMpApiCsv("A,B,C\n1,2,3"), /sin columna DATE/);
  });
});

// El reporte de la cuenta ARGENTINA no trae RECORD_TYPE. Estas filas son
// textuales del reporte real del consultorio (27/8/26), con los montos
// cambiados salvo el primero.
const CSV_AR = [
  "DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;TRANSACTION_APPROVAL_DATE;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID",
  "2026-08-22T00:00:00.000-03:00;;;17764471.35;0.00;17764471.35;0.00;0.00;;;;;17764471.35;;",
  "2026-08-24T03:38:36.000-03:00;1748794838982;asset_management;28012.03;0.00;28012.03;0.00;0.00;available_money;2026-08-24T03:38:36.000-03:00;;;17792483.38;;",
  "2026-08-24T15:24:20.000-03:00;174491419095;payment;99400.00;0.00;100000.00;0.00;-600.00;cvu;2026-08-24T15:24:20.000-03:00;;;17891883.38;bank_transfer;",
  "2026-08-25T11:00:00.000-03:00;174491419096;payout;0.00;50000.00;50000.00;0.00;0.00;;2026-08-25T11:00:00.000-03:00;;;17841883.38;;",
].join("\n");

describe("parseMpApiCsv — variante Argentina (sin RECORD_TYPE)", () => {
  it("saca el saldo inicial de la fila sin operación ni concepto", () => {
    const r = parseMpApiCsv(CSV_AR);
    assert.equal(r.control.inicial, 17764471.35);
    assert.equal(r.movimientos.length, 3);
  });

  it("la fecha sale del ISO con offset de la cuenta", () => {
    assert.equal(parseMpApiCsv(CSV_AR).movimientos[0].fecha, "2026-08-24");
  });

  it("crédito positivo, débito negativo, neto de comisiones", () => {
    const [m1, m2, m3] = parseMpApiCsv(CSV_AR).movimientos;
    assert.equal(m1.monto, 28012.03);
    assert.equal(m2.monto, 99400);        // bruto 100.000 menos 600 de impuestos
    assert.equal(m3.monto, -50000);       // un retiro
  });

  it("el medio de pago entra en la descripción, que es lo que se concilia", () => {
    const [m1, m2] = parseMpApiCsv(CSV_AR).movimientos;
    assert.equal(m1.descripcion, "asset_management · available_money");
    assert.equal(m2.descripcion, "payment · cvu");
  });

  it("conserva el SOURCE_ID, que es la primera capa de dedup", () => {
    assert.equal(parseMpApiCsv(CSV_AR).movimientos[1].source_id, "174491419095");
  });

  it("no rompe el reporte de México, que sí trae RECORD_TYPE", () => {
    assert.equal(parseMpApiCsv(CSV).movimientos.length, 3);
    assert.equal(parseMpApiCsv(CSV).control.inicial, 1500);
  });
});

describe("parseMpApiCsv — la fila de cierre", () => {
  // Fila de totales TEXTUAL del reporte real (27/8/26): trae BALANCE_AMOUNT en
  // 0,00 y el saldo verdadero en NET_CREDIT. Leer la columna equivocada dejaba
  // registrado "saldo final 0" para una cuenta con 17 millones.
  const CIERRE = ";;;17676402.00;0.00;17692358.26;0.00;-15956.26;;;;;0.00;;";

  it("el saldo final sale del crédito, no de BALANCE_AMOUNT", () => {
    const r = parseMpApiCsv(CSV_AR + "\n" + CIERRE);
    assert.equal(r.control.inicial, 17764471.35);
    assert.equal(r.control.final, 17676402);
    assert.equal(r.movimientos.length, 3);   // y no cuenta como movimiento
  });

  it("una fila de control sin importes no pisa el saldo con un cero", () => {
    const r = parseMpApiCsv(CSV_AR + "\n" + ";;;;;;;;;;;;;;");
    // queda el saldo corriente del último movimiento, que es el último dato real
    assert.equal(r.control.final, 17841883.38);
  });
});

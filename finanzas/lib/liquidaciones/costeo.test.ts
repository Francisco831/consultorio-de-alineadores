import { test } from "node:test";
import assert from "node:assert/strict";
import { costearCuotas, calcularLiquidaciones, clavePaciente } from "./costeo";
import type { CobroAlineador } from "./costeo";

const PRECIO = { list_price: 2731000, discount_pct: 40 };   // Full 2 maxilares adultos
const CUOTA_DE_6 = Math.round((2731000 * 0.6) / 6);         // 273.100
const CUOTA_DE_4 = Math.round((2731000 * 0.6) / 4);         // 409.650

function cobro(p: Partial<CobroAlineador> & { id: string; seq: number }): CobroAlineador {
  return {
    paciente: "Perez Juan", fecha: "2026-03-01", ars: 100000, usd: 0,
    motivo: "", texto: "", ...p,
  };
}

test("clavePaciente: el orden y los acentos no cambian la identidad", () => {
  assert.equal(clavePaciente("Pérez Viviana"), clavePaciente("perez viviana"));
  assert.equal(clavePaciente("Pérez Viviana"), clavePaciente("Viviana Perez"));
  // los tokens de 2 letras o menos no cuentan
  assert.equal(clavePaciente("De La Cruz Ana"), "ana cruz");
});

test("una cuota se costea UNA vez aunque se pague en dos partes", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "a cta de cuota 2 de 6", texto: "a cta de cuota 2 de 6" }),
    cobro({ id: "b", seq: 2, motivo: "saldo de cuota 2 de 6", texto: "saldo de cuota 2 de 6" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), CUOTA_DE_6);
  assert.equal(r.costoArs.get("b"), undefined);
});

test('"cuotas 3 y 4 de 4" cobra DOBLE', () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "cuotas 3 y 4 de 4", texto: "cuotas 3 y 4 de 4" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), CUOTA_DE_4 * 2);
});

test("regresión Evelin Herrera: dos cuotas el mismo día y monto se costean las dos", () => {
  // el plan sale de una fila previa ("cuota 1 de 4"); las dos de julio no dicen
  // cuota, y solo el MOTIVO completo las distingue
  const r = costearCuotas([
    cobro({ id: "abr", seq: 1, fecha: "2026-04-22", ars: 1200000, motivo: "cuota 1 de 4", texto: "cuota 1 de 4", paciente: "Herrera Evelin" }),
    cobro({ id: "may", seq: 2, fecha: "2026-07-04", ars: 1200000, motivo: "pago cuota mayo Dra Franco", texto: "pago cuota mayo Dra Franco", paciente: "Evelin Herrera" }),
    cobro({ id: "jun", seq: 3, fecha: "2026-07-04", ars: 1200000, motivo: "pago cuota junio Dra Franco", texto: "pago cuota junio Dra Franco", paciente: "Evelin Herrera" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("abr"), CUOTA_DE_4);
  assert.equal(r.costoArs.get("may"), CUOTA_DE_4);
  assert.equal(r.costoArs.get("jun"), CUOTA_DE_4, "la segunda cuota del día también cuesta");
});

test("etapa adicional no carga costo", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "cuota 2 de 6 etapa adicional", texto: "cuota 2 de 6 etapa adicional" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), undefined);
});

test("sin plan conocido no se inventa costo", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "pago", texto: "pago" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), undefined);
  assert.equal(r.sinCostear, 1);
});

test("liquidación: 40% del cobrado neto de costo KS, menos retiros", () => {
  const costoArs = new Map([["c1", 682750]]);
  const l = calcularLiquidaciones([
    { id: "c1", doctora: "Eugenia Digiano", periodo: "2026-01", ars: 2333500, usd: 0, tipo: "cobro" },
  ], costoArs, new Map(), () => 40);
  assert.equal(l[0].baseArs, 1650750);
  assert.equal(l[0].liquidacionArs, 660300);   // el número real de enero
});

test("el retiro ya cobrado se descuenta del saldo", () => {
  const l = calcularLiquidaciones([
    { id: "c1", doctora: "Mariana Matelli", periodo: "2026-01", ars: 1000000, usd: 0, tipo: "cobro" },
    { id: "r1", doctora: "Mariana Matelli", periodo: "2026-01", ars: 300000, usd: 0, tipo: "retiro_liquidacion" },
  ], new Map(), new Map(), () => 40);
  assert.equal(l[0].liquidacionArs, 400000);
  assert.equal(l[0].retiros, 300000);
  assert.equal(l[0].saldo, 100000);
});

test("precio por paciente (tipos Noloco): MEDIUM carga su precio, el resto el default", () => {
  {
    const r = costearCuotas(
      [
        { id: "a", paciente: "Tonello Fiorella", fecha: "2026-08-01", ars: 500000, usd: 0, motivo: "cuota 1 de 4", texto: "cuota 1 de 4", seq: 1 },
        { id: "b", paciente: "Otro Paciente", fecha: "2026-08-01", ars: 500000, usd: 0, motivo: "cuota 1 de 4", texto: "cuota 1 de 4", seq: 2 },
      ],
      {
        precioDefault: { list_price: 2731000, discount_pct: 40 },
        precioPorPaciente: new Map([["fiorella tonello", { list_price: 1748000, discount_pct: 40 }]]),
      }
    );
    assert.equal(r.costoArs.get("a"), Math.round((1748000 * 0.6) / 4));  // 262.200
    assert.equal(r.costoArs.get("b"), Math.round((2731000 * 0.6) / 4));  // 409.650
  }
});

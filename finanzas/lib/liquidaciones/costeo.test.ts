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

test("proporcional: dos partes de una cuota suman exactamente una cuota de costo", () => {
  // cuota limpia de 650.000 fija el pacto (6 × 650.000); las dos partes de la
  // cuota 2 descuentan cada una su proporción de la plata que entró
  const r = costearCuotas([
    cobro({ id: "c1", seq: 1, ars: 650000, motivo: "cuota 1 de 6", texto: "cuota 1 de 6" }),
    cobro({ id: "a", seq: 2, ars: 300000, motivo: "a cta de cuota 2 de 6", texto: "a cta de cuota 2 de 6" }),
    cobro({ id: "b", seq: 3, ars: 350000, motivo: "saldo de cuota 2 de 6", texto: "saldo de cuota 2 de 6" }),
  ], { precioDefault: PRECIO });
  const costo = 2731000 * 0.6;
  assert.equal(r.costoArs.get("c1"), CUOTA_DE_6);
  assert.equal(r.costoArs.get("a"), Math.round(costo * 300000 / 3900000));
  assert.equal(r.costoArs.get("b"), Math.round(costo * 350000 / 3900000));
  assert.equal(
    r.costoArs.get("a")! + r.costoArs.get("b")!, CUOTA_DE_6,
    "las dos partes juntas valen una cuota"
  );
});

test('"cuotas 3 y 4 de 4" descuenta doble porque entró plata doble', () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "cuotas 3 y 4 de 4", texto: "cuotas 3 y 4 de 4" }),
  ], { precioDefault: PRECIO });
  // el pacto se infiere de la fila doble: cuota = monto/2, precio = 4 × cuota
  assert.equal(r.costoArs.get("a"), CUOTA_DE_4 * 2);
});

test("regresión Evelin Herrera: dos cuotas el mismo día y monto descuentan las dos", () => {
  // el pacto sale de la fila previa ("cuota 1 de 4" de 1.200.000 → 4.800.000);
  // las dos de julio no dicen cuota pero cada una trae 1.200.000 → 1/4 cada una
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

test("sin plan ni precio pactado no se inventa costo", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "pago", texto: "pago" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), undefined);
  assert.equal(r.sinCostear, 1);
});

test("pacto en USD pagado en pesos: se cruza al t/c de la fila (caso Hogner)", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 592000, paciente: "Hogner Agustina",
      motivo: "cuota 2 de 7 t/c 1480", texto: "cuota 2 de 7 t/c 1480" }),
  ], { precioDefault: PRECIO, precioPactadoUsd: { "hogner agustina": 2800 } });
  // 592.000 / 1480 = USD 400 → 400/2.800 = 1/7 del costo del caso
  assert.equal(r.costoArs.get("a"), Math.round((2731000 * 0.6) / 7));  // 234.086
});

test("el costo acumulado nunca supera el costo total del caso (tope)", () => {
  // pacto 2 × 500.000 = 1.000.000; entran 3 pagos de 500.000 (uno de más):
  // el tercero no descuenta nada porque el caso ya cargó su costo completo
  const costo = 2731000 * 0.6;
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 500000, motivo: "cuota 1 de 2", texto: "cuota 1 de 2" }),
    cobro({ id: "b", seq: 2, ars: 500000, motivo: "cuota 2 de 2", texto: "cuota 2 de 2" }),
    cobro({ id: "c", seq: 3, ars: 500000, motivo: "refuerzo", texto: "refuerzo" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), Math.round(costo / 2));
  assert.equal(r.costoArs.get("b"), Math.round(costo / 2));
  assert.equal(r.costoArs.get("c"), 0, "el excedente no carga costo");
  assert.equal(
    r.costoArs.get("a")! + r.costoArs.get("b")! + (r.costoArs.get("c") ?? 0),
    Math.round(costo)
  );
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

test("lista histórica: el caso paga la lista vigente a su INGRESO, con su tipo real", () => {
  // números reales validados contra la liquidación del contador (julio/26)
  const listas = [
    { validFrom: "2025-12-01", precios: new Map([
      ["adultos/full/2", { list_price: 2483000, discount_pct: 40 }],
      ["adultos/medium/2", { list_price: 1589000, discount_pct: 40 }],
    ]) },
    { validFrom: "2026-05-01", precios: new Map([
      ["adultos/full/2", { list_price: 2731000, discount_pct: 40 }],
      ["adultos/medium/2", { list_price: 1748000, discount_pct: 40 }],
    ]) },
  ];
  const r = costearCuotas(
    [
      // Gallo entró en abril (lista vieja): TODAS sus cuotas cargan esa lista,
      // aunque caigan cobradas con la lista nueva ya vigente
      { id: "g1", paciente: "Gallo Gaston", fecha: "2026-04-24", ars: 650000, usd: 0, motivo: "Abona cuota 1 de 6", texto: "Abona cuota 1 de 6", seq: 1 },
      { id: "g2", paciente: "Gallo Gastón", fecha: "2026-07-15", ars: 650000, usd: 0, motivo: "cuota 2 de 6", texto: "cuota 2 de 6", seq: 2 },
      // Szalontai entró en julio (lista nueva) y sus cuotas son desparejas:
      // el costo sale del % cobrado sobre su precio pactado ($3.800.000)
      { id: "s1", paciente: "Szalontai Natalia", fecha: "2026-07-14", ars: 2300000, usd: 0, motivo: "Abona cuota 1 de 4", texto: "Abona cuota 1 de 4", seq: 3 },
      // Tonello: primera fila visible ya va por la cuota 3 → ingreso estimado
      // 2 meses antes (marzo, lista vieja) + tipo MEDIUM de Noloco
      { id: "t1", paciente: "Tonello Fiorella", fecha: "2026-05-20", ars: 500000, usd: 0, motivo: "cuota 3 de 4", texto: "cuota 3 de 4", seq: 4 },
    ],
    {
      precioDefault: { list_price: 2731000, discount_pct: 40 },
      listas,
      tipoPorPaciente: new Map([["fiorella tonello", "adultos/medium/2"]]),
      precioPactado: { "Szalontai Natalia": 3800000 },
    }
  );
  assert.equal(r.costoArs.get("g1"), 248300);   // 2.483.000×0,6 × 650.000/3.900.000
  assert.equal(r.costoArs.get("g2"), 248300);
  assert.equal(r.costoArs.get("s1"), Math.round(1638600 * 2300000 / 3800000));  // 991.836
  assert.equal(r.costoArs.get("t1"), 238350);   // 1.589.000×0,6 × 500.000/2.000.000 — el número del cierre de junio
});

test("la fecha de ingreso real (Noloco) le gana a la inferida", () => {
  const listas = [
    { validFrom: "2025-12-01", precios: new Map([["adultos/full/2", { list_price: 2483000, discount_pct: 40 }]]) },
    { validFrom: "2026-05-01", precios: new Map([["adultos/full/2", { list_price: 2731000, discount_pct: 40 }]]) },
  ];
  // la cuota 1 se cobró en mayo, pero el caso ENTRÓ en abril según Noloco
  const r = costearCuotas(
    [{ id: "a", paciente: "Perez Juan", fecha: "2026-05-10", ars: 500000, usd: 0, motivo: "cuota 1 de 6", texto: "cuota 1 de 6", seq: 1 }],
    {
      precioDefault: { list_price: 2731000, discount_pct: 40 },
      listas,
      ingresoPorPaciente: new Map([["juan perez", "2026-04-20"]]),
    }
  );
  assert.equal(r.costoArs.get("a"), 248300);
});

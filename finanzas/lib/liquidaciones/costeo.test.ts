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
    { id: "c1", doctora: "Eugenia Digiano", periodo: "2026-01", ars: 2333500, tipo: "cobro" },
  ], costoArs, () => 40);
  assert.equal(l[0].baseArs, 1650750);
  assert.equal(l[0].liquidacionArs, 660300);   // el número real de enero
});

test("el retiro ya cobrado se descuenta del saldo", () => {
  const l = calcularLiquidaciones([
    { id: "c1", doctora: "Mariana Matelli", periodo: "2026-01", ars: 1000000, tipo: "cobro" },
    { id: "r1", doctora: "Mariana Matelli", periodo: "2026-01", ars: 300000, tipo: "retiro_liquidacion" },
  ], new Map(), () => 40);
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

test("la etapa adicional es gratis en Full, se cobra en Medium", () => {
  // Daira Castellón (Pancho, 25/8/26): su tratamiento era Medium, así que la
  // etapa adicional NO viene incluida — sale $498.000 de LISTA, y la doctora la
  // paga con su 40% de descuento: $298.800. Sin esto, el texto "etapa
  // adicional" la dejaba en cero como a cualquier Full.
  const cobros = [
    { id: "d1", paciente: "Daira Castellon", fecha: "2026-07-13", ars: 400000, usd: 0,
      motivo: "cuota 1 de 3 etapa adicional", texto: "cuota 1 de 3 etapa adicional", seq: 1 },
    // Cugat sigue sin costo: no tiene costo puesto a mano
    { id: "c1", paciente: "Cugat Fernanda", fecha: "2026-07-13", ars: 400000, usd: 0,
      motivo: "cuota 1 de 3 etapa adicional", texto: "cuota 1 de 3 etapa adicional", seq: 2 },
  ];
  const r = costearCuotas(cobros, {
    precioDefault: { list_price: 2731000, discount_pct: 40 },
    precioPactado: { "daira castellon": 1200000, "cugat fernanda": 1200000 },
    etapaAdicional: new Set(["cugat fernanda"]),
    costoEtapaAdicional: { "daira castellon": 498000 },
  });
  assert.equal(r.costoArs.get("d1"), 298800);            // 498.000 − 40%, completo
  assert.equal(r.costoArs.get("c1"), undefined);         // sigue sin costo
  assert.match(r.etiquetas.get("d1")!, /\$498\.000 de lista menos 40%/);
  assert.match(r.etiquetas.get("c1")!, /sin costo/);
});

test("etapa adicional de un no-Full sin precio cargado: se marca, no se regala", () => {
  const r = costearCuotas(
    [{ id: "x1", paciente: "Medium Maria", fecha: "2026-07-01", ars: 400000, usd: 0,
       motivo: "cuota 1 de 3 etapa adicional", texto: "cuota 1 de 3 etapa adicional", seq: 1 }],
    {
      precioDefault: { list_price: 2731000, discount_pct: 40 },
      tipoPorPaciente: new Map([["maria medium", "adultos/medium/2"]]),
      precioPactado: { "medium maria": 1200000 },
    }
  );
  assert.equal(r.costoArs.get("x1"), undefined);
  assert.equal(r.sinCostear, 1);
  assert.match(r.etiquetas.get("x1")!, /falta su precio/);
});

test("el t/c manda desde la serie del blue, no desde el que escribió la caja", () => {
  // la fila dice 1480 pero ese día el blue cerró en 1510: gana el blue
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 604000, paciente: "Hogner Agustina",
      motivo: "cuota 2 de 7 t/c 1480", texto: "cuota 2 de 7 t/c 1480" }),
  ], {
    precioDefault: PRECIO,
    precioPactadoUsd: { "hogner agustina": 2800 },
    tcPorFecha: () => 1510,
  });
  // 604.000 / 1510 = USD 400 → 400/2.800 = 1/7 del costo del caso
  assert.equal(r.costoArs.get("a"), Math.round((2731000 * 0.6) / 7));
  assert.match(r.etiquetas.get("a")!, /t\/c 1510/);
});

test("sin cotización de esa fecha, el t/c escrito en la fila sigue siendo la red", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 592000, paciente: "Hogner Agustina",
      motivo: "cuota 2 de 7 t/c 1480", texto: "cuota 2 de 7 t/c 1480" }),
  ], {
    precioDefault: PRECIO,
    precioPactadoUsd: { "hogner agustina": 2800 },
    tcPorFecha: () => undefined,
  });
  assert.equal(r.costoArs.get("a"), Math.round((2731000 * 0.6) / 7));
});

test("un cobro en dólares carga su costo KS en PESOS (caso Botto)", () => {
  // cuota 3 de 5 de US$ 360 contra un pacto de US$ 2.800: 12,9% del caso. El
  // porcentaje se saca en dólares (no pasa por el t/c), pero el costo sale en
  // pesos, que es la moneda de la lista KS y de la liquidación.
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 0, usd: 360, paciente: "Botto Agustina",
      fecha: "2026-07-03", motivo: "Abona cuota 3 de 5", texto: "Abona cuota 3 de 5" }),
  ], {
    precioDefault: PRECIO,
    precioPactadoUsd: { "botto agustina": 2800 },
    tcPorFecha: () => 1505,
  });
  assert.equal(r.costoArs.get("a"), Math.round(2731000 * 0.6 * (360 / 2800)));
  assert.equal(r.etiquetas.get("a")!.includes("USD"), true, "la etiqueta dice contra qué precio prorratea");
});

test("un caso declarado sin costo no paga la etapa adicional aunque no sea Full", () => {
  // Declarar el caso es decidir sobre ÉL: le gana al tipo de tratamiento, que
  // puede faltar en Noloco o venir mal. Y la grafía del Set no importa: se
  // normaliza igual que el resto ("Cugat Fernanda" ≡ "Fernanda Cugat").
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 400000, paciente: "Fernanda Cugat",
      motivo: "cuota 1 de 3 etapa adicional", texto: "cuota 1 de 3 etapa adicional" }),
  ], {
    precioDefault: PRECIO,
    tipoPorPaciente: new Map([[clavePaciente("Fernanda Cugat"), "adultos/medium/2"]]),
    etapaAdicional: new Set(["Fernanda Cugat"]),
  });
  assert.equal(r.costoArs.get("a") ?? 0, 0);
  assert.equal(r.sinCostear, 0, "no se marca para revisar: ya está decidido");
});

test("la etapa adicional NO se prorratea: el costo entra entero en el primer cobro", () => {
  // KS la factura de una vez (Pancho, 26/8/26), así que el costo no se reparte
  // entre las cuotas: la cuota 1 se lo lleva completo y las siguientes, cero.
  const cuota = (id: string, seq: number, n: number) =>
    cobro({ id, seq, ars: 400000, paciente: "Daira Castellón",
      fecha: `2026-0${6 + seq}-13`,
      motivo: `cuota ${n} de 3 etapa adicional`, texto: `cuota ${n} de 3 etapa adicional` });
  const r = costearCuotas([cuota("a", 1, 1), cuota("b", 2, 2), cuota("c", 3, 3)], {
    precioDefault: PRECIO,
    precioPactado: { "daira castellon": 1200000 },
    costoEtapaAdicional: { "daira castellon": 498000 },
  });
  assert.equal(r.costoArs.get("a"), 298800, "el primer cobro carga la etapa entera");
  assert.equal(r.costoArs.get("b"), 0, "la cuota 2 ya no cuesta nada");
  assert.equal(r.costoArs.get("c"), 0);
});

test("el descuento de la etapa adicional sale de la lista del caso, no de una constante", () => {
  const conOtroDto = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 400000, paciente: "Daira Castellón",
      motivo: "cuota 1 de 3 etapa adicional", texto: "cuota 1 de 3 etapa adicional" }),
  ], {
    precioDefault: { list_price: 2731000, discount_pct: 50 },
    precioPactado: { "daira castellon": 1200000 },
    costoEtapaAdicional: { "daira castellon": 498000 },
  });
  assert.equal(conOtroDto.costoArs.get("a"), 249000);   // 498.000 − 50%
});

test("descuento especial: el costo KS del caso baja 16% (Nisenbaum, Grillo, Etchegoyen)", () => {
  const base = { id: "a", seq: 1, ars: 650000, motivo: "cuota 1 de 6", texto: "cuota 1 de 6" };
  const sinDto = costearCuotas([cobro(base)], { precioDefault: PRECIO });
  const conDto = costearCuotas([cobro(base)], {
    precioDefault: PRECIO, descuentoKsEspecial: { "perez juan": 16 },
  });
  assert.equal(conDto.costoArs.get("a"), Math.round(sinDto.costoArs.get("a")! * 0.84));
  assert.match(conDto.etiquetas.get("a")!, /16% de descuento especial/);
});

test("una contención no lleva costo KS aunque la caja la ponga en Alineadores", () => {
  // Pancho, 26/8/26. Son cobros del mismo paciente y del mismo tratamiento, pero
  // no son una cuota: antes quedaban marcados "SIN COSTEAR" con alarma al lado.
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 200000, motivo: "Contenciones", texto: "Contenciones" }),
    cobro({ id: "b", seq: 2, ars: 60000, motivo: "placa bis de tratamiento", texto: "placa bis de tratamiento" }),
    cobro({ id: "c", seq: 3, ars: 50000, motivo: "contenciones de tratamiento entregadas por Maru",
      texto: "contenciones de tratamiento entregadas por Maru" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), undefined);
  assert.equal(r.costoArs.get("b"), undefined);
  assert.equal(r.costoArs.get("c"), undefined);
  assert.equal(r.sinCostear, 0, "no se marcan como problema: es una regla, no un dato faltante");
  assert.match(r.etiquetas.get("a")!, /sin costo KS/);
});

test("un cobro que es cuota Y contención sigue costeando la cuota", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 650000, motivo: "cuota 1 de 6 + contención",
      texto: "cuota 1 de 6 + contención" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), CUOTA_DE_6);
});

// ---------------------------------------------------------------------------
// Pago total del tratamiento (Pancho, 2/9/26) y costo puesto a mano (0030)
// ---------------------------------------------------------------------------

test("pago total: el caso de Castiglioni carga el costo entero sin pacto ni cuotas", () => {
  // el motivo real de la caja del 28/8/26; no dice "cuota N de Y" y la paciente
  // no tiene pacto cargado, así que hasta hoy quedaba SIN COSTEAR
  const r = costearCuotas([
    cobro({
      id: "a", seq: 410, fecha: "2026-08-28", ars: 3638700, paciente: "Castiglioni Isabella",
      motivo: "Abona total tratamiento U$S 2600 con 10% descuento",
      texto: "Abona total tratamiento U$S 2600 con 10% descuento",
    }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), Math.round(2731000 * 0.6));
  assert.equal(r.sinCostear, 0);
  assert.match(r.etiquetas.get("a")!, /paga el tratamiento entero/);
});

test("pago total: las otras formas que escribe la caja también costean", () => {
  for (const texto of [
    "Abona tratamiento completo con 10% descuento",
    "Abona  total del tratamiento",
    "Abona el tratamiento con 10% de descuento",
    "paga el total",
    "pago total",
    "cancela el tratamiento",
  ]) {
    const r = costearCuotas([cobro({ id: "a", seq: 1, ars: 3000000, motivo: texto, texto })],
      { precioDefault: PRECIO });
    assert.equal(r.costoArs.get("a"), Math.round(2731000 * 0.6), `no costeó: "${texto}"`);
  }
});

test("pago total: un parcial, una cuota o una etapa adicional NO son el 100%", () => {
  for (const texto of [
    "abona resto del tratamiento",          // parcial: RE_PARCIAL
    "saldo total del tratamiento",          // parcial aunque diga total
    "Abona el tratamiento en 6 cuotas",     // describe el plan, no lo paga entero
    "cuota 6 de 6, cancela el tratamiento", // la última cuota, no el caso
    "abona total tratamiento adicional",    // la etapa tiene sus propias reglas
    "abona cuota 1 de 6 descontado el anticipo",
    "abona de contado",                     // eso es el MEDIO de pago
  ]) {
    const r = costearCuotas([cobro({ id: "a", seq: 1, ars: 500000, motivo: texto, texto })],
      { precioDefault: PRECIO });
    assert.notEqual(
      r.costoArs.get("a"), Math.round(2731000 * 0.6),
      `cargó el caso entero a un cobro que no lo paga: "${texto}"`
    );
  }
});

test("pago total: el tope evita que un caso con pacto cargue su costo dos veces", () => {
  const r = costearCuotas([
    cobro({ id: "t", seq: 1, fecha: "2026-01-10", ars: 3000000, motivo: "abona tratamiento completo", texto: "abona tratamiento completo" }),
    cobro({ id: "c", seq: 2, fecha: "2026-02-10", ars: 300000, motivo: "cuota 2 de 6", texto: "cuota 2 de 6" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("t"), Math.round(2731000 * 0.6));
  assert.equal(r.costoArs.get("c"), 0, "el caso ya cargó su costo completo");
});

test("costo a mano: el número escrito gana sobre toda regla, incluso una contención", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "contención", texto: "contención" }),
  ], {
    precioDefault: PRECIO,
    costoManualArs: new Map([["a", { monto: 250000, motivo: "lo pagó la clínica" }]]),
  });
  assert.equal(r.costoArs.get("a"), 250000);
  assert.match(r.etiquetas.get("a")!, /puesto a mano — lo pagó la clínica/);
});

test("costo a mano: consume el tope del caso, así las cuotas siguientes no lo cobran de nuevo", () => {
  const costo = Math.round(2731000 * 0.6);
  const r = costearCuotas([
    cobro({ id: "c1", seq: 1, fecha: "2026-01-05", ars: 650000, motivo: "cuota 1 de 6", texto: "cuota 1 de 6" }),
    cobro({ id: "c2", seq: 2, fecha: "2026-02-05", ars: 650000, motivo: "cuota 2 de 6", texto: "cuota 2 de 6" }),
  ], {
    precioDefault: PRECIO,
    costoManualArs: new Map([["c1", { monto: costo, motivo: "el caso entero" }]]),
  });
  assert.equal(r.costoArs.get("c1"), costo);
  assert.equal(r.costoArs.get("c2"), 0, "el caso ya cargó su costo completo");
});

test("costo a mano: un cobro sin costear deja de estar sin costear", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, motivo: "abona", texto: "abona" }),
  ], {
    precioDefault: PRECIO,
    costoManualArs: new Map([["a", { monto: 100000, motivo: "acordado" }]]),
  });
  assert.equal(r.sinCostear, 0);
  assert.equal(r.costoArs.get("a"), 100000);
});

test("pago total: regresión Gonzalez Alzaga — el texto dice todo pero el monto dice seña", () => {
  // Dos filas del 21/1/26 con el MISMO motivo: $75.000 y US$ 2.200. Sin la
  // prueba de monto, la chica (que viene primera por seq) se llevaba el costo
  // entero del caso y la grande quedaba en $0 por el tope.
  const r = costearCuotas([
    cobro({
      id: "chica", seq: 423, fecha: "2026-01-21", ars: 75000, usd: 0,
      paciente: "Gonzalez Alzaga Elisa",
      motivo: "Abona  total del tratamiento", texto: "Abona  total del tratamiento",
    }),
    cobro({
      id: "grande", seq: 424, fecha: "2026-01-21", ars: 0, usd: 2200,
      paciente: "Gonzalez Alzaga Elisa",
      motivo: "Abona  total del tratamiento", texto: "Abona  total del tratamiento",
    }),
  ], {
    precioDefault: PRECIO,
    precioPactadoUsd: { "Gonzalez Alzaga Elisa": 2200 },
    tcPorFecha: () => 1250,
  });
  const costo = Math.round(2731000 * 0.6);
  assert.ok(
    r.costoArs.get("chica")! < costo * 0.1,
    `la seña de $75.000 no puede cargar el caso entero (cargó ${r.costoArs.get("chica")})`
  );
  assert.equal(r.costoArs.get("grande"), costo - r.costoArs.get("chica")!,
    "el costo del caso lo carga el cobro que sí lo paga");
});

test("pago total: sin precio conocido se le cree al texto — es el caso Castiglioni", () => {
  const r = costearCuotas([
    cobro({ id: "a", seq: 1, ars: 3638700, motivo: "Abona total tratamiento", texto: "Abona total tratamiento" }),
  ], { precioDefault: PRECIO });
  assert.equal(r.costoArs.get("a"), Math.round(2731000 * 0.6));
});

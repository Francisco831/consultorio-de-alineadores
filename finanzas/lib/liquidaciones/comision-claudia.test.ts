import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { comisionPorMes, tratamientosNuevos, type PagoAlineadores } from "./comision-claudia";

const pago = (p: Partial<PagoAlineadores>): PagoAlineadores => ({
  occurred_on: "2026-03-10", counterparty_id: "a", paciente: "Ana", separada: false, ...p,
});

describe("tratamientosNuevos", () => {
  it("cuenta solo la PRIMERA cuota de cada paciente", () => {
    const n = tratamientosNuevos([
      pago({ occurred_on: "2026-03-10", counterparty_id: "a" }),
      pago({ occurred_on: "2026-04-12", counterparty_id: "a" }),  // cuota 2, no cuenta
      pago({ occurred_on: "2026-04-01", counterparty_id: "b", paciente: "Beto" }),
    ]);
    assert.equal(n.length, 2);
    assert.deepEqual(n.map((x) => x.mes).sort(), ["2026-03", "2026-04"]);
  });

  it("los pacientes de la caja Coni no cuentan", () => {
    const n = tratamientosNuevos([
      pago({ counterparty_id: "c", separada: true }),
      pago({ counterparty_id: "d" }),
    ]);
    assert.equal(n.length, 1);
  });

  it("sin contraparte cae al nombre; sin nada se descarta", () => {
    const n = tratamientosNuevos([
      pago({ counterparty_id: null, paciente: "Zoe" }),
      pago({ counterparty_id: null, paciente: "Zoe", occurred_on: "2026-05-01" }),
      pago({ counterparty_id: null, paciente: null }),
    ]);
    assert.equal(n.length, 1);
    assert.equal(n[0].mes, "2026-03");
  });
});

describe("dedup y arranques a mitad", () => {
  it("variantes del mismo nombre son UN paciente", () => {
    const n = tratamientosNuevos([
      pago({ counterparty_id: "x", paciente: "Tonello Fiorella", occurred_on: "2026-03-01" }),
      pago({ counterparty_id: "y", paciente: "Fiorella Tonello", occurred_on: "2026-06-01" }),
      pago({ counterparty_id: "z", paciente: "Lázaro Magdalena", occurred_on: "2026-02-01" }),
      pago({ counterparty_id: "w", paciente: "Lazaro Magdalena", occurred_on: "2026-05-01" }),
    ]);
    assert.equal(n.length, 2);
  });

  it("un tratamiento que arranca en cuota 2 no es venta nueva", () => {
    const n = tratamientosNuevos([
      pago({ paciente: "Vieja", descripcion: "cuota 3 de 6", occurred_on: "2026-01-05" }),
      pago({ counterparty_id: "b", paciente: "Nueva", descripcion: "Abona cuota 1 de 4" }),
      pago({ counterparty_id: "c", paciente: "Saldos", descripcion: "saldo de cuota 2 de 4" }),
    ]);
    assert.deepEqual(n.map((x) => x.paciente), ["Nueva"]);
  });
});

describe("comisionPorMes", () => {
  it("100.000 por tratamiento", () => {
    const m = comisionPorMes(tratamientosNuevos([
      pago({ counterparty_id: "a" }),
      pago({ counterparty_id: "b", paciente: "Beto", occurred_on: "2026-03-20" }),
    ]));
    assert.equal(m.get("2026-03")!.cantidad, 2);
    assert.equal(m.get("2026-03")!.comision, 200_000);
    assert.deepEqual(m.get("2026-03")!.pacientes.sort(), ["Ana", "Beto"]);
  });
});

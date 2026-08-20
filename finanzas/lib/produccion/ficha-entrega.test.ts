// Cada bloque fija una decisión que se tomó mirando el archivo real.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { consolidarEnvios, claveEnvio, esEnvio, type EnvioFicha } from "./ficha-entrega";

const envio = (p: Partial<EnvioFicha>): EnvioFicha => ({
  hoja: "2026", fila: 2, fecha: "2026-03-04", id: "BN279", etapa: "1.0",
  paciente: "Mateos Soto", alineadores: 18, ...p,
});

describe("claveEnvio", () => {
  it("el mismo caso y etapa en dos hojas es UN envío", () => {
    assert.equal(
      claveEnvio(envio({ hoja: "2026" })),
      claveEnvio(envio({ hoja: "SkyDropx", fila: 40, fecha: "2026-03-05" }))
    );
  });

  it("dos etapas del mismo caso son envíos distintos", () => {
    assert.notEqual(claveEnvio(envio({})), claveEnvio(envio({ etapa: "2.0" })));
  });

  it("sin ID cae a paciente + etapa + fecha, no colapsa pacientes distintos", () => {
    const a = claveEnvio(envio({ id: null, paciente: "Godoy Claudia" }));
    const b = claveEnvio(envio({ id: null, paciente: "Gaona Ignacio" }));
    assert.notEqual(a, b);
    assert.match(a, /^p:/);
  });
});

describe("esEnvio", () => {
  it("una recarga de saldo de SkyDropx no es un envío", () => {
    // Las hojas por transportista llevan la cuenta corriente del courier:
    // sumarlas como cajas inventaba 66 envíos en 2026.
    assert.equal(esEnvio(envio({ etapa: "Recarga", id: null, paciente: null })), false);
    assert.equal(esEnvio(envio({ etapa: "Cargos Extra envio", id: null, paciente: null })), false);
  });

  it("un renglón sin caso ni paciente no es un envío aunque no diga recarga", () => {
    assert.equal(esEnvio(envio({ etapa: null, id: null, paciente: null })), false);
  });

  it("un envío con caso sí lo es", () => {
    assert.equal(esEnvio(envio({})), true);
    assert.equal(esEnvio(envio({ id: null, paciente: "Godoy Claudia" })), true);
  });
});

describe("consolidarEnvios", () => {
  it("no suma dos veces el envío que aparece en la hoja del año y en la del transportista", () => {
    // El bug que este test evita: sumar las 4 hojas daba 9.000 alineadores
    // cuando México había enviado 5.000.
    const r = consolidarEnvios([
      envio({ hoja: "2026", alineadores: 18 }),
      envio({ hoja: "SkyDropx", fila: 90, alineadores: 18 }),
    ]);
    assert.equal(r.meses.length, 1);
    assert.equal(r.meses[0].alineadores, 18);
    assert.equal(r.meses[0].envios, 1);
  });

  it("cuando una hoja trae el número y la otra no, gana el número", () => {
    const r = consolidarEnvios([
      envio({ hoja: "Lalamove", alineadores: null }),
      envio({ hoja: "2026", alineadores: 20 }),
    ]);
    assert.equal(r.meses[0].alineadores, 20);
  });

  it("el envío duplicado se imputa al mes de la fecha MÁS TEMPRANA", () => {
    const r = consolidarEnvios([
      envio({ hoja: "SkyDropx", fecha: "2026-04-01" }),
      envio({ hoja: "2026", fecha: "2026-03-31" }),
    ]);
    assert.deepEqual(r.meses.map((m) => m.period), ["2026-03"]);
  });

  it('"-" en alineadores es cero explícito, no dato faltante', () => {
    const r = consolidarEnvios([envio({ alineadores: "-", bisContencion: "Contencion" })]);
    assert.equal(r.meses[0].alineadores, 0);
    assert.equal(r.meses[0].envios, 1);
    assert.equal(r.meses[0].enviosConAlineadores, 0);
    assert.equal(r.meses[0].sinAlineadores.contencion, 1);
    assert.equal(r.descartados.length, 0, '"-" no es un descarte que haya que auditar');
  });

  it("un envío con alineadores y contención cuenta sus alineadores", () => {
    // La columna marca qué MÁS iba en la caja. Leerla como tipo de envío
    // borraba 2.306 alineadores de 2026 (las etapas finales).
    const r = consolidarEnvios([envio({ alineadores: 18, bisContencion: "Contencion" })]);
    assert.equal(r.meses[0].alineadores, 18);
    assert.equal(r.meses[0].enviosConAlineadores, 1);
  });

  it("los envíos de 1 o 2 placas sueltas se cuentan como repeticiones, y suman", () => {
    const r = consolidarEnvios([
      envio({ id: "BM604", etapa: "3.0", alineadores: 1, bisContencion: null }),
      envio({ id: "BN545", etapa: "SM", alineadores: 2, bisContencion: null }),
      envio({ id: "BN118", etapa: "M", alineadores: 20, bisContencion: "BIS" }),
    ]);
    assert.equal(r.meses[0].repeticiones, 2);
    assert.equal(r.meses[0].alineadores, 23);
  });

  it("un valor ilegible no se cuela como monto ni desaparece en silencio", () => {
    const r = consolidarEnvios([envio({ alineadores: "20 y 21" })]);
    assert.equal(r.meses[0].alineadores, 0);
    assert.equal(r.descartados.length, 1);
    assert.match(r.descartados[0].motivo, /ilegible/);
  });

  it("respeta la ventana pedida", () => {
    const r = consolidarEnvios(
      [envio({ fecha: "2025-12-10" }), envio({ fecha: "2026-01-10", etapa: "2.0" })],
      { desde: "2026-01" }
    );
    assert.deepEqual(r.meses.map((m) => m.period), ["2026-01"]);
  });
});

describe("el archivo real de México", () => {
  const raw = JSON.parse(readFileSync("seed-data/ficha_entrega_mx.json", "utf8"));
  const r = consolidarEnvios(raw.envios as EnvioFicha[], { desde: "2026-01", hasta: "2026-08" });

  it("2026 da los 8 meses, sin agujeros", () => {
    assert.deepEqual(
      r.meses.map((m) => m.period),
      ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]
    );
  });

  it("el total deduplicado está lejos del total crudo: la dedup hace algo", () => {
    const total = r.meses.reduce((a, m) => a + m.alineadores, 0);
    const crudo = (raw.envios as EnvioFicha[])
      .filter((e) => e.fecha && e.fecha >= "2026-01" && e.fecha < "2026-09")
      .reduce((a, e) => a + (typeof e.alineadores === "number" ? e.alineadores : 0), 0);
    assert.ok(total > 4000 && total < 6000, `total fuera de rango: ${total}`);
    assert.ok(crudo > total * 1.4, `sin dedup daría ${crudo} contra ${total}`);
  });

  it("no se cuela ninguna recarga de courier como envío", () => {
    const recargas = (raw.envios as EnvioFicha[]).filter(
      (e) => e.fecha && e.fecha >= "2026-01" && e.fecha < "2026-09" && !esEnvio(e)
    );
    assert.ok(recargas.length > 50, "el archivo real tiene esos renglones");
    const envios = r.meses.reduce((a, m) => a + m.envios, 0);
    assert.ok(envios < 400, `quedaron ${envios} envíos: entraron recargas`);
  });

  it("ningún mes queda en cero ni descontrolado", () => {
    for (const m of r.meses) {
      assert.ok(m.alineadores > 200, `${m.period} tiene ${m.alineadores}`);
      assert.ok(m.alineadores < 1500, `${m.period} tiene ${m.alineadores}`);
      assert.ok(m.enviosConAlineadores > 0);
    }
  });
});

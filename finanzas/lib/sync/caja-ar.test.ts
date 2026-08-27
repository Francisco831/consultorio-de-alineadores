import { test } from "node:test";
import assert from "node:assert/strict";
import { regresionesDeMesesCerrados } from "./caja-ar";

const mapa = (o: Record<string, number>) => new Map(Object.entries(o));
const HOY = "2026-08";

test("un mes cerrado que se achica es una regresión", () => {
  const r = regresionesDeMesesCerrados(
    mapa({ "2026-07|ARS|income": 16_909_400 }),
    mapa({ "2026-07|ARS|income": 16_579_400 }),
    HOY
  );
  assert.equal(r.length, 1);
  assert.match(r[0], /2026-07\|ARS\|income/);
});

test("una fila que desaparece entera del mes cerrado también", () => {
  const r = regresionesDeMesesCerrados(mapa({ "2026-03|USD|income": 1200 }), mapa({}), HOY);
  assert.equal(r.length, 1);
});

test("el mes en curso puede moverse para cualquier lado", () => {
  assert.deepEqual(
    regresionesDeMesesCerrados(
      mapa({ "2026-08|ARS|income": 5_000_000 }),
      mapa({ "2026-08|ARS|income": 100 }),
      HOY
    ),
    []
  );
});

test("los gastos se corrigen a mano: no son regresión", () => {
  assert.deepEqual(
    regresionesDeMesesCerrados(
      mapa({ "2026-05|ARS|expense": 800_000 }),
      mapa({ "2026-05|ARS|expense": 0 }),
      HOY
    ),
    []
  );
});

test("crecer o quedarse igual nunca es regresión", () => {
  assert.deepEqual(
    regresionesDeMesesCerrados(
      mapa({ "2026-06|ARS|income": 1000, "2026-04|ARS|income": 500 }),
      mapa({ "2026-06|ARS|income": 1500, "2026-04|ARS|income": 500 }),
      HOY
    ),
    []
  );
});

// El caso que casi traba el cron: los overrides tienen que salir de LOS DOS
// lados. Si el gate mira la base (que ya los tiene aplicados) contra la fuente,
// agregar un override que baje un mes cerrado se lee como un borrado — y como
// aborta antes de escribir, la base nunca baja y el cron falla para siempre.
// Reproduce el override real caja:4153d36ba4901d24 (ignorar, 15/7, $330.000).
test("agregar un override sobre un mes cerrado NO es regresión", () => {
  const BASE_CON_OVERRIDE = 16_909_400;   // lo que hay hoy en la base
  const OVERRIDE = 330_000;               // la fila que el override saca

  // mal: la base entera contra la fuente ya filtrada → falso positivo
  assert.equal(
    regresionesDeMesesCerrados(
      mapa({ "2026-07|ARS|income": BASE_CON_OVERRIDE }),
      mapa({ "2026-07|ARS|income": BASE_CON_OVERRIDE - OVERRIDE }),
      HOY
    ).length,
    1
  );

  // bien: la fila con override sale de los dos lados → no hay regresión
  assert.deepEqual(
    regresionesDeMesesCerrados(
      mapa({ "2026-07|ARS|income": BASE_CON_OVERRIDE - OVERRIDE }),
      mapa({ "2026-07|ARS|income": BASE_CON_OVERRIDE - OVERRIDE }),
      HOY
    ),
    []
  );
});

test("con los overrides afuera, un borrado real se sigue detectando", () => {
  const r = regresionesDeMesesCerrados(
    mapa({ "2026-07|ARS|income": 16_579_400 }),
    mapa({ "2026-07|ARS|income": 15_000_000 }),
    HOY
  );
  assert.equal(r.length, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { avisosDeSync, diasEntre } from "./alertas-sync";

const HOY = "2026-08-26";

test("una corrida ok de hoy no genera aviso", () => {
  assert.deepEqual(avisosDeSync([{ source: "caja_ar", started_at: "2026-08-26T10:00:00Z", status: "ok" }], HOY), []);
});

test("una corrida ok de hace 2 días todavía no molesta; a los 3 sí", () => {
  assert.equal(avisosDeSync([{ source: "caja_ar", started_at: "2026-08-24T10:00:00Z", status: "ok" }], HOY).length, 0);
  const a = avisosDeSync([{ source: "caja_ar", started_at: "2026-08-23T10:00:00Z", status: "ok" }], HOY);
  assert.equal(a.length, 1);
  assert.match(a[0].titulo, /sin sincronizar hace 3 días/);
  assert.equal(a[0].severidad, "atencion");
});

test("un fallo es crítico aunque sea de hoy", () => {
  const a = avisosDeSync([{ source: "pagos_mx", started_at: "2026-08-26T10:00:00Z", status: "error" }], HOY);
  assert.equal(a[0].severidad, "critica");
  assert.match(a[0].titulo, /Pagos de México: la última sincronización falló/);
});

test("una corrida colgada avisa recién al día siguiente", () => {
  // arrancó hoy y sigue corriendo: puede estar corriendo de verdad
  assert.equal(avisosDeSync([{ source: "caja_ar", started_at: "2026-08-26T10:00:00Z", status: "running" }], HOY).length, 0);
  const a = avisosDeSync([{ source: "caja_ar", started_at: "2026-08-25T10:00:00Z", status: "running" }], HOY);
  assert.match(a[0].titulo, /quedó colgada/);
});

test("de cada fuente vale la ÚLTIMA corrida, no las viejas", () => {
  // vienen ordenadas de más nueva a más vieja
  const a = avisosDeSync([
    { source: "caja_ar", started_at: "2026-08-26T10:00:00Z", status: "ok" },
    { source: "caja_ar", started_at: "2026-08-20T10:00:00Z", status: "error" },
  ], HOY);
  assert.deepEqual(a, [], "el error viejo ya se resolvió: no se avisa");
});

test("una fuente que nunca corrió no inventa un aviso", () => {
  assert.deepEqual(avisosDeSync([], HOY), []);
});

test("los días son de calendario, no de 24 horas", () => {
  assert.equal(diasEntre("2026-08-25T23:59:00Z", "2026-08-26"), 1);
  assert.equal(diasEntre("2026-08-26T00:01:00Z", "2026-08-26"), 0);
});

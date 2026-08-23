import { test } from "node:test";
import assert from "node:assert/strict";
import { planesPacientes, motivoCompleto, pareceCuota } from "./planes-pacientes";

test("plan en curso: cuotas pagadas, pendiente estimado con la última cuota", () => {
  const r = planesPacientes([
    { paciente: "Gallo Gaston", fecha: "2026-06-10", ars: 600000, usd: 0, motivo: "cuota 1 de 4", doctora: "Matelli" },
    { paciente: "Gaston Gallo", fecha: "2026-07-12", ars: 620000, usd: 0, motivo: "cuota 2 de 4", doctora: "Matelli" },
    { paciente: "Gallo Gaston", fecha: "2026-08-20", ars: 650000, usd: 0, motivo: "cuota 3", doctora: "Matelli" },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].plan, 4);
  assert.equal(r[0].cuotasPagadas, 3);        // "cuota 3" sin "de Y" también cuenta
  assert.equal(r[0].pagadoArs, 1870000);
  assert.equal(r[0].pendienteCuotas, 1);
  assert.equal(r[0].pendienteEstimadoArs, 650000);
});

test("cuotas dobles pagan dos y el plan cerrado no debe nada", () => {
  const r = planesPacientes([
    { paciente: "Ana", fecha: "2026-05-01", ars: 800000, usd: 0, motivo: "cuotas 1 y 2 de 4", doctora: null },
    { paciente: "Ana", fecha: "2026-06-01", ars: 820000, usd: 0, motivo: "cuotas 3 y 4 de 4", doctora: null },
  ]);
  assert.equal(r[0].pendienteCuotas, 0);
  assert.equal(r[0].pendienteEstimadoArs, 0);
});

test("clasifica morosos: plan incompleto y más de 75 días sin pagar", () => {
  const pagos = [
    { paciente: "Moroso Juan", fecha: "2026-03-10", ars: 500000, usd: 0, motivo: "cuota 2 de 6", doctora: "M" },
    { paciente: "Aldia Ana", fecha: "2026-08-05", ars: 500000, usd: 0, motivo: "cuota 3 de 6", doctora: "M" },
    { paciente: "Completo Luis", fecha: "2026-02-01", ars: 500000, usd: 0, motivo: "cuota 4 de 4", doctora: "M" },
  ];
  const r = planesPacientes(pagos, "2026-08-21");
  const por = Object.fromEntries(r.map((p) => [p.paciente, p.estado]));
  assert.equal(por["Moroso Juan"], "moroso");
  assert.equal(por["Aldia Ana"], "al_dia");
  assert.equal(por["Completo Luis"], "completo");
});

test("variantes del mismo nombre se fusionan en un solo plan", () => {
  const pagos = [
    { paciente: "Colimodio Maria", fecha: "2026-03-18", ars: 580000, usd: 0, motivo: "cuota 1 de 6", doctora: "M" },
    { paciente: "Maria José Colimodio", fecha: "2026-06-10", ars: 583333, usd: 0, motivo: "cuota 6 de 6", doctora: "M" },
  ];
  const r = planesPacientes(pagos, "2026-08-21");
  assert.equal(r.length, 1);
  assert.equal(r[0].estado, "completo");
});

test("typos y apodos no parten el plan (Romino=Romina, Magui=Magdalena)", () => {
  const pagos = [
    { paciente: "Morabito Romina", fecha: "2026-02-04", ars: 980000, usd: 0, motivo: "cuota 2 de 4", doctora: "M" },
    { paciente: "Morabito Romino", fecha: "2026-06-10", ars: 980000, usd: 0, motivo: "Abona cuota 4 de 4", doctora: "M" },
    { paciente: "Lázaro Magdalena", fecha: "2026-08-05", ars: 600000, usd: 0, motivo: "Abona cuota 6 de 6", doctora: "M" },
    { paciente: "Magui Lazaro", fecha: "2026-05-06", ars: 600000, usd: 0, motivo: "cuota 4 de 6", doctora: "M" },
  ];
  const r = planesPacientes(pagos, "2026-08-21");
  assert.equal(r.length, 2);
  assert.ok(r.every((p) => p.estado === "completo"));
});

test("plan en dólares: cadencia y pendiente estimado en USD", () => {
  const pagos = [
    { paciente: "Etchegoyen Ignacio", fecha: "2026-03-27", ars: 0, usd: 500, motivo: "Abona cuota1 de 6 y parte de cuota 2 de 6", doctora: "M" },
    { paciente: "Etchegoyen Ignacio", fecha: "2026-08-21", ars: 0, usd: 500, motivo: "tc 1550", doctora: "M" },
  ];
  const r = planesPacientes(pagos, "2026-08-21");
  assert.equal(r.length, 1);
  assert.equal(r[0].estado, "al_dia");        // pagó hoy: al día aunque el plan siga abierto
  assert.ok(r[0].pendienteEstimadoUsd > 0);   // lo que falta se estima en USD
  assert.equal(r[0].pendienteEstimadoArs, 0);
});

test("la barra mide plata: un pago grande sin número avanza aunque 'vaya 1 de 6'", () => {
  const r = planesPacientes([
    { paciente: "Evelin H", fecha: "2026-05-01", ars: 600000, usd: 0, motivo: "cuota 1 de 6", doctora: null },
    { paciente: "Evelin H", fecha: "2026-06-15", ars: 1800000, usd: 0, motivo: "abona parte del tratamiento", doctora: null },
  ], "2026-07-01");
  // por cuotas sería 1/6 = 17%; por plata: 2,4M pagado vs 3M estimado → 44%
  assert.equal(r[0].cuotasPagadas, 1);
  assert.equal(r[0].progresoPct, 44);
});

test("plan en dólares: el progreso usa la plata en USD", () => {
  const r = planesPacientes([
    { paciente: "Nacho E", fecha: "2026-06-01", ars: 0, usd: 400, motivo: "cuotas 1 y 2 de 6", doctora: null },
    { paciente: "Nacho E", fecha: "2026-07-01", ars: 0, usd: 400, motivo: "cuota 3 de 6 tc 1550", doctora: null },
  ], "2026-07-10");
  // pagado USD 800, pendiente 3 × 400 = 1.200 → 40%
  assert.equal(r[0].progresoPct, 40);
});

test("pareceCuota detecta cuotas aunque el texto esté corrido de columna", () => {
  assert.ok(pareceCuota("Abona cuota1 de 6 y parte de cuota 2 de 6"));
  assert.ok(pareceCuota("cta. 3"));
  assert.ok(pareceCuota("tc 1550"));
  assert.ok(pareceCuota("t/c $1.550"));
  assert.ok(!pareceCuota("consulta"));
  assert.ok(!pareceCuota("mensualidad julio"));
  assert.ok(!pareceCuota("compró 5 etc 5"));  // "etc" no es tipo de cambio
});

test("motivoCompleto junta motivo, obs y medio — la única forma válida de armarlo", () => {
  assert.equal(
    motivoCompleto("Etchegoyen", { obs: null, medio_raw: "Abona cuota1 de 6" }).trim(),
    "Etchegoyen  Abona cuota1 de 6".trim()
  );
  assert.ok(pareceCuota(motivoCompleto(null, { medio_raw: "tc 1550" })));
});

test("una parte de cuota chica NO pisa la última cuota conocida", () => {
  const r = planesPacientes([
    { paciente: "Lucia P", fecha: "2026-04-01", ars: 600000, usd: 0, motivo: "cuota 1 de 6", doctora: null },
    { paciente: "Lucia P", fecha: "2026-05-01", ars: 600000, usd: 0, motivo: "cuota 2 de 6", doctora: null },
    { paciente: "Lucia P", fecha: "2026-06-01", ars: 100000, usd: 0, motivo: "abona parte de cuota 3 de 6", doctora: null },
  ], "2026-06-10");
  // la cuota sigue siendo 600k: faltan 3 × 600k, no 3 × 100k
  assert.equal(r[0].pendienteEstimadoArs, 1800000);
  assert.equal(r[0].progresoPct, 42);  // 1,3M / 3,1M — no 81%
});

test("si SOLO hay filas parciales, el monto sirve de piso de cuota (Etchegoyen)", () => {
  const r = planesPacientes([
    { paciente: "Nacho E", fecha: "2026-03-27", ars: 0, usd: 500, motivo: "Abona cuota1 de 6 y parte de cuota 2 de 6", doctora: null },
    { paciente: "Nacho E", fecha: "2026-05-06", ars: 0, usd: 300, motivo: "Abona cuota 2 de 6 U$S 250 y a cta de cuota 3 de 6 U$S 50", doctora: null },
  ], "2026-05-10");
  // la parcial de 300 no baja la cuota de 500: pendiente 4 × 500
  assert.equal(r[0].cuotasPagadas, 2);
  assert.equal(r[0].pendienteEstimadoUsd, 2000);
});

test("una seña parcial en otra moneda no cambia la moneda del plan", () => {
  const r = planesPacientes([
    { paciente: "Mix M", fecha: "2026-04-01", ars: 600000, usd: 0, motivo: "cuota 1 de 4", doctora: null },
    { paciente: "Mix M", fecha: "2026-05-01", ars: 0, usd: 50, motivo: "parte de cuota 2 de 4", doctora: null },
  ], "2026-05-10");
  assert.equal(r[0].pendienteEstimadoUsd, 0);
  assert.equal(r[0].pendienteEstimadoArs, 1200000);  // 2 × 600k
});

test("plan terminado: pendiente 0 y barra 100 aunque falten cuotas del histórico", () => {
  const r = planesPacientes([
    { paciente: "Vieja V", fecha: "2026-02-01", ars: 583333, usd: 0, motivo: "cuota 6 de 6", doctora: null },
  ], "2026-08-01");
  assert.equal(r[0].estado, "completo");
  assert.equal(r[0].pendienteCuotas, 0);
  assert.equal(r[0].pendienteEstimadoArs, 0);
  assert.equal(r[0].progresoPct, 100);
});

test("un typo tipo 'cuota 3 de 600.000' no fabrica un plan de 600 cuotas", () => {
  const r = planesPacientes([
    { paciente: "Typo T", fecha: "2026-04-01", ars: 600000, usd: 0, motivo: "cuota 3 de 600.000", doctora: null },
  ], "2026-05-01");
  assert.equal(r.length, 0);  // sin plan válido no entra a la lista
});

test("el progreso nunca es negativo", () => {
  const r = planesPacientes([
    { paciente: "Nota C", fecha: "2026-04-01", ars: 600000, usd: 0, motivo: "cuota 1 de 4", doctora: null },
    { paciente: "Nota C", fecha: "2026-05-01", ars: -900000, usd: 0, motivo: "ajuste", doctora: null },
  ], "2026-05-10");
  assert.equal(r[0].progresoPct, 0);
});

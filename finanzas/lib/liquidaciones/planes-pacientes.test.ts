import { test } from "node:test";
import assert from "node:assert/strict";
import { planesPacientes } from "./planes-pacientes";

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

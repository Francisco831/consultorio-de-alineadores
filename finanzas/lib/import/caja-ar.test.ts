import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rawAMovs, classify, type MovCaja } from "./caja-ar";

// El contrato del port: sobre el MISMO raw, este parser tiene que dar
// exactamente lo que da scripts/parse_caja.py. Los dos archivos de seed-data
// son un par (raw + su salida), así que sirven de caso de oro con 977 filas
// reales. Si esto se rompe, las external_key se movieron y el próximo sync
// duplica media caja.
const dir = resolve(__dirname, "../../seed-data");
const raw = JSON.parse(readFileSync(resolve(dir, "caja_ar_raw.json"), "utf8"));
const esperado = JSON.parse(readFileSync(resolve(dir, "movimientos_ar_2026.json"), "utf8")) as MovCaja[];

test("rawAMovs reproduce la salida de parse_caja.py sobre el raw real", () => {
  const obtenido = rawAMovs(raw);
  assert.equal(obtenido.length, esperado.length, "cantidad de movimientos");
  for (let i = 0; i < esperado.length; i++) {
    assert.deepEqual(obtenido[i], esperado[i], `movimiento #${i} (${esperado[i].fecha} ${esperado[i].paciente})`);
  }
});

test("classify: las reglas que deciden la categoría", () => {
  assert.deepEqual(classify("Ana", "Abona cuota 2 de 6", "", 100000, null), ["cobro", "Alineadores"]);
  assert.deepEqual(classify("Ana", "resto del tratamiento", "", 100000, null), ["cobro", "Alineadores"]);
  assert.deepEqual(classify("Ana", "", "tc 1550", 100000, null), ["cobro", "Alineadores"]);
  assert.deepEqual(classify("Ana", "contención", "", 50000, null), ["cobro", "Contención"]);
  assert.deepEqual(classify("Ana", "1era consulta", "", 35000, null), ["cobro", "Consulta"]);
  assert.deepEqual(classify("Ana", "Agosto", "", 60000, null), ["cobro", "Mensualidad"]);
  assert.deepEqual(classify("Ana", "", "", 60000, null), ["cobro", "Otros"]);
  assert.deepEqual(classify("", "Retiro liquidación", "", -500000, null), ["retiro_liquidacion", null]);
  assert.deepEqual(classify("", "botones", "", -8000, null), ["gasto_tratamiento", null]);
  assert.deepEqual(classify("", "librería", "", -8000, null), ["gasto_consultorio", null]);
  // el medio entra al texto: la caja corre columnas y la cuota cae ahí
  assert.deepEqual(classify("Ana", "", "", 100000, null, "Abona cuota1 de 6"), ["cobro", "Alineadores"]);
});

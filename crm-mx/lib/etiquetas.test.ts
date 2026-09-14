// Si dos personas escriben la misma etiqueta de dos maneras y quedan distintas,
// la lista sale partida y el filtro miente. Esto prueba que no pase.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  esEtiquetaDelSistema,
  etiquetaLegible,
  normalizarEtiqueta,
} from "./etiquetas";

const FORMATO_DE_LA_BASE = /^[a-z0-9][a-z0-9:._-]{0,59}$/;

describe("normalizarEtiqueta", () => {
  it("dos escrituras de la misma etiqueta quedan iguales", () => {
    assert.equal(normalizarEtiqueta("Summit 2026"), "summit-2026");
    assert.equal(normalizarEtiqueta("summit-2026"), "summit-2026");
    assert.equal(normalizarEtiqueta("  SUMMIT_2026 "), "summit-2026");
    assert.equal(normalizarEtiqueta("#summit  2026"), "summit-2026");
  });

  it("saca acentos y la ñ, que no entran en el formato de la base", () => {
    assert.equal(normalizarEtiqueta("Interesado en Escáner"), "interesado-en-escaner");
    assert.equal(normalizarEtiqueta("Niños"), "ninos");
  });

  it("respeta el prefijo con dos puntos, sin espacios alrededor", () => {
    assert.equal(normalizarEtiqueta("evento: Summit 2026"), "evento:summit-2026");
    assert.equal(normalizarEtiqueta("evento :summit"), "evento:summit");
  });

  it("no arranca ni termina en símbolo", () => {
    assert.equal(normalizarEtiqueta("--summit--"), "summit");
    assert.equal(normalizarEtiqueta(":summit:"), "summit");
    assert.equal(normalizarEtiqueta("summit..."), "summit");
  });

  it("lo que no tiene nada usable queda vacío", () => {
    assert.equal(normalizarEtiqueta(""), "");
    assert.equal(normalizarEtiqueta("   "), "");
    assert.equal(normalizarEtiqueta("¿¡!?"), "");
    assert.equal(normalizarEtiqueta("---"), "");
  });

  it("recorta a 40 y lo que queda sigue cumpliendo el formato de la base", () => {
    const larga = normalizarEtiqueta("a".repeat(39) + "b" + "c".repeat(20));
    assert.equal(larga.length, 40);
    assert.match(larga, FORMATO_DE_LA_BASE);
    const cortadaEnGuion = normalizarEtiqueta("a".repeat(39) + "-" + "b".repeat(20));
    assert.match(cortadaEnGuion, FORMATO_DE_LA_BASE);
    assert.ok(!cortadaEnGuion.endsWith("-"));
  });

  it("cualquier entrada que devuelva algo cumple el check de la base", () => {
    for (const raw of [
      "Summit 2026",
      "evento: Summit 2026",
      "Ñandú & Cía.",
      "interesado_en_escaner",
      "KeepDay!!!",
      "12 meses",
      "ç ü ö",
    ]) {
      const t = normalizarEtiqueta(raw);
      if (t) assert.match(t, FORMATO_DE_LA_BASE, `"${raw}" → "${t}"`);
    }
  });
});

describe("esEtiquetaDelSistema", () => {
  it("las del censo y los imports son del sistema", () => {
    assert.equal(esEtiquetaDelSistema("sigue-instagram"), true);
    assert.equal(esEtiquetaDelSistema("fuente:outbound"), true);
    assert.equal(esEtiquetaDelSistema("competidor:invisalign"), true);
    assert.equal(esEtiquetaDelSistema("ig-alt:drasonrisa"), true);
    assert.equal(esEtiquetaDelSistema("ig:ortodoncista"), true);
  });

  it("las que carga el equipo no", () => {
    assert.equal(esEtiquetaDelSistema("summit-2026"), false);
    assert.equal(esEtiquetaDelSistema("evento:amo-2025"), false);
    assert.equal(esEtiquetaDelSistema("interesado-en-escaner"), false);
    // el prefijo cuenta entero: "igual" no es "ig:"
    assert.equal(esEtiquetaDelSistema("igual-que-siempre"), false);
  });
});

describe("etiquetaLegible", () => {
  it("abre el prefijo y los guiones para leer", () => {
    assert.equal(etiquetaLegible("evento:summit-2026"), "evento: summit 2026");
    assert.equal(etiquetaLegible("summit-2026"), "summit 2026");
  });
});

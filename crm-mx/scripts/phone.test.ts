// Clave canónica de teléfono: es lo que decide si dos filas son el mismo doctor.
// Un cambio acá mueve fusiones y adopciones de fichas, así que se prueba.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonPhone, canonEmail } from "./lib/phone";

describe("canonPhone", () => {
  it("el mismo número escrito de cuatro formas da UNA sola clave", () => {
    // Es el caso real: Noloco guarda +52, WhatsApp guarda 521, y las planillas
    // guardan los 10 dígitos pelados. Con claves distintas el mismo doctor no
    // matchea entre fuentes y termina duplicado.
    const esperado = "525512345678";
    assert.equal(canonPhone("5512345678"), esperado);
    assert.equal(canonPhone("525512345678"), esperado);
    assert.equal(canonPhone("5215512345678"), esperado);
    assert.equal(canonPhone("+52 (55) 1234-5678"), esperado);
  });

  it("la regla de los 10 dígitos estaba en una sola de las tres copias", () => {
    // import-prospectos-fuentes la tenía; import-prospectos y merge-prospect-dups
    // no. Sin ella, "5512345678" y "525512345678" eran doctores distintos.
    assert.equal(canonPhone("5512345678"), canonPhone("525512345678"));
  });

  it("no confunde el 521 legacy con un número que simplemente empieza en 521", () => {
    // 5219999999 son 10 dígitos: es un número local, no un móvil con prefijo.
    assert.equal(canonPhone("5219999999"), "525219999999");
  });

  it("descarta lo que no es un teléfono usable", () => {
    assert.equal(canonPhone(null), null);
    assert.equal(canonPhone(""), null);
    assert.equal(canonPhone("sin datos"), null);
    assert.equal(canonPhone("12345"), null);
  });
});

describe("canonEmail", () => {
  it("normaliza espacios y mayúsculas", () => {
    assert.equal(canonEmail("  Dra.Perez@Clinica.MX "), "dra.perez@clinica.mx");
  });

  it("no acepta lo que no es un email", () => {
    assert.equal(canonEmail(null), null);
    assert.equal(canonEmail("sin correo"), null);
  });
});

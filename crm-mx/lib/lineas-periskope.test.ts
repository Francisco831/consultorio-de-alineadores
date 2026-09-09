import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lineasPeriskope } from "./lineas-periskope";

describe("lineasPeriskope", () => {
  test("parsea teléfono=nombre separados por ; y respeta el orden", () => {
    assert.deepEqual(
      lineasPeriskope("5215500000001=Ortodoncia Keep; 5215500000002=Juan ;5491100000003=Dra. Rocío Puig"),
      [
        { phone: "5215500000001", nombre: "Ortodoncia Keep" },
        { phone: "5215500000002", nombre: "Juan" },
        { phone: "5491100000003", nombre: "Dra. Rocío Puig" },
      ]
    );
  });

  test("sin nombre queda 'sin nombre' y el teléfono se limpia a dígitos", () => {
    assert.deepEqual(lineasPeriskope("+52 1 55 0000 0004"), [{ phone: "5215500000004", nombre: "sin nombre" }]);
  });

  test("sin variable no hay líneas, y lo que no es un teléfono se descarta", () => {
    assert.deepEqual(lineasPeriskope(undefined), []);
    assert.deepEqual(lineasPeriskope("hola=Juan;;"), []);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { medioCanonico, esUsd } from "./medios";

// Las 31 variantes REALES de los 877 movimientos Ene–Jul 2026.
const CASOS: Array<[string, string | null]> = [
  ["Tr Ks", "ks"], ["Tr ks", "ks"], ["tr ks", "ks"], ["TR KS", "ks"],
  ["TR Ks", "ks"], ["TR ks", "ks"], ["depo Ks", "ks"], ["Tr Ks 31/10/25", "ks"],
  ["TR KS U$S", "ks"], ["Tr Ks U$S", "ks"], ["TR ks US$", "ks"],
  ["TR MP", "mp"], ["Tr mp", "mp"], ["tr mp", "mp"], ["TR Mp", "mp"], ["mp", "mp"],
  ["TR MP Basilico-Lavalle", "mp"], ["Tr MP Basilico Lavalle", "mp"],
  ["ef", "efectivo"], ["efe", "efectivo"], ["Ef", "efectivo"], ["Efe", "efectivo"],
  ["efectivo", "efectivo"], ["Efectivo", "efectivo"],
  ["Tr Coni", "coni"], ["TR Coni", "coni"], ["Tr coni", "coni"],
  ["", null],
  ["Abona cuota1 de 6 y parte de cuota 2 de 6", null],
  ["cuota 3 de 4", null],
  ["USD Transferencia", null],
];

test("medioCanonico: las 31 variantes reales", () => {
  for (const [raw, want] of CASOS) {
    assert.equal(medioCanonico(raw), want, `medio ${JSON.stringify(raw)}`);
  }
});

test("esUsd detecta sufijos U$S/US$/USD", () => {
  assert.equal(esUsd("TR KS U$S"), true);
  assert.equal(esUsd("TR ks US$"), true);
  assert.equal(esUsd("Tr Ks"), false);
});

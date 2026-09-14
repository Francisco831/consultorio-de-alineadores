import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { recortarAlrededor } from "./recorte";

const LARGO =
  "Hablé con la doctora por WhatsApp. Le interesa ir al Summit de octubre pero " +
  "todavía no confirmó porque depende de la agenda del consultorio y de si consigue " +
  "quien la cubra esa semana. Quedamos en volver a hablar el lunes.";

describe("recortarAlrededor", () => {
  it("un texto corto vuelve entero, con los espacios normalizados", () => {
    assert.equal(recortarAlrededor("  hola   mundo\n", "mundo"), "hola mundo");
  });

  it("centra la ventana en lo buscado y marca lo que quedó afuera", () => {
    const r = recortarAlrededor(LARGO, "summit", 60);
    assert.ok(r.toLowerCase().includes("summit"), r);
    assert.ok(r.startsWith("…") && r.endsWith("…"), r);
    assert.ok(r.length <= 62, `${r.length}: ${r}`);
  });

  it("no distingue mayúsculas", () => {
    assert.ok(recortarAlrededor(LARGO, "SUMMIT", 60).toLowerCase().includes("summit"));
  });

  it("si lo buscado está al principio, no pone puntos suspensivos adelante", () => {
    const r = recortarAlrededor(LARGO, "Hablé", 60);
    assert.ok(r.startsWith("Hablé"), r);
    assert.ok(r.endsWith("…"), r);
  });

  it("si lo buscado no aparece (matcheó en otra columna), devuelve el comienzo", () => {
    const r = recortarAlrededor(LARGO, "zzz", 60);
    assert.ok(r.startsWith("Hablé con la doctora"), r);
    assert.ok(r.endsWith("…"), r);
  });

  it("no parte palabras cuando hay un espacio cerca", () => {
    const r = recortarAlrededor(LARGO, "agenda", 60).replace(/…/g, "");
    const primera = r.split(" ")[0];
    const ultima = r.split(" ").at(-1)!;
    assert.ok(LARGO.split(/\s+/).includes(primera), `arranca a mitad de palabra: "${primera}"`);
    assert.ok(
      LARGO.split(/\s+/).some((w) => w.replace(/[.,]$/, "") === ultima.replace(/[.,]$/, "")),
      `termina a mitad de palabra: "${ultima}"`
    );
  });
});

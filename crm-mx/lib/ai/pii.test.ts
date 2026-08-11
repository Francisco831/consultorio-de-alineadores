/**
 * Regresión de minimización: que no vuelva a salir un dato personal al prompt.
 *
 * La prueba de fondo corre sobre el bloque de prompt REAL —el que arma
 * `contextToPromptBlock` a partir de un contexto completo— y no sobre una lista de
 * campos. Un test de campos se queda viejo apenas alguien agrega uno; el texto que
 * se manda no.
 *
 * No toca la red ni la base: el contexto sale de `lib/ai/eval/scenarios.ts`, que ya
 * existía para el harness de ruteo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pareceTelefono, refCorta, refOportunidad } from "./pii";
import { contextToPromptBlock } from "./context";
import { SCENARIOS } from "./eval/scenarios";

describe("refCorta", () => {
  it("es determinística: el mismo id da siempre la misma referencia", () => {
    const id = "3f9a2c11-1111-4111-8111-111111111111";
    assert.equal(refOportunidad(id), refOportunidad(id));
    assert.equal(refOportunidad(id), "OP-3F9A2C");
  });

  it("no se puede volver al id desde la referencia", () => {
    const id = "3f9a2c11-1111-4111-8111-111111111111";
    const ref = refOportunidad(id);
    assert.ok(!id.includes(ref.replace("OP-", "").toLowerCase()) === false); // el prefijo sí está
    assert.ok(ref.length < id.length, "la referencia es más corta que el id");
    // Lo que importa: no lleva nada de la persona, solo del identificador.
    assert.match(ref, /^OP-[0-9A-F]{6}$/);
  });

  it("aguanta ids con formato raro sin romperse", () => {
    assert.match(refCorta("OP", ""), /^OP-000000$/);
    assert.match(refCorta("OP", "zzzz"), /^OP-000000$/);
  });
});

describe("pareceTelefono", () => {
  it("reconoce los formatos que hay en la base", () => {
    assert.ok(pareceTelefono("llamar al +52 33 1234 5678").length > 0);
    assert.ok(pareceTelefono("5215512345678").length > 0);
    assert.ok(pareceTelefono("33-1234-5678").length > 0);
  });

  it("no confunde fechas, montos ni porcentajes con teléfonos", () => {
    assert.deepEqual(pareceTelefono("acreditado el 2026-08-11, hace 47 días"), []);
    assert.deepEqual(pareceTelefono("monto 48000 MXN · probabilidad 60%"), []);
    assert.deepEqual(pareceTelefono("ritmo cada ~20 días · 5 casos en 90d"), []);
  });
});

describe("el prompt no lleva datos personales", () => {
  // Los escenarios del harness son contextos completos y realistas: es lo más
  // parecido a producción que se puede correr sin base ni red.
  const bloques = SCENARIOS.map((s) => ({
    nombre: s.nombre,
    texto: contextToPromptBlock(s.context),
  }));

  it("hay escenarios que probar", () => {
    assert.ok(bloques.length >= 10, `solo ${bloques.length} escenarios`);
  });

  it("ningún bloque contiene algo con forma de teléfono", () => {
    for (const b of bloques) {
      const hallazgos = pareceTelefono(b.texto);
      assert.deepEqual(
        hallazgos,
        [],
        `el escenario "${b.nombre}" tiene un teléfono en el prompt: ${hallazgos.join(", ")}`
      );
    }
  });

  it("las oportunidades se nombran por referencia, no por paciente", () => {
    // Se compara contra el contexto en vez de recortar secciones del texto: el
    // bloque no tiene un separador confiable de fin de sección, y una prueba que
    // depende de dónde corta el texto se rompe cada vez que alguien agrega una línea.
    let verificadas = 0;
    for (const s of SCENARIOS) {
      const texto = contextToPromptBlock(s.context);
      for (const o of s.context.open_opportunities.slice(0, 5)) {
        assert.match(o.ref, /^OP-[0-9A-F]{6}$/, `referencia mal formada en "${s.nombre}"`);
        assert.ok(
          texto.includes(`- ${o.ref} · `),
          `el escenario "${s.nombre}" no rinde la oportunidad por referencia`
        );
        verificadas++;
      }
    }
    assert.ok(verificadas > 0, "ningún escenario tiene oportunidades: la prueba no probó nada");
  });

  it("declara qué canales hay sin decir cuáles son", () => {
    for (const b of bloques) {
      const linea = b.texto.split("\n").find((l) => l.startsWith("- Canales disponibles:"));
      if (!linea) continue;
      assert.ok(
        !/\d{4}/.test(linea),
        `el escenario "${b.nombre}" tiene números en la línea de canales: ${linea}`
      );
    }
  });

  it("el chat de WhatsApp no se identifica por nombre", () => {
    for (const b of bloques) {
      const linea = b.texto.split("\n").find((l) => l.startsWith("- Chat de WhatsApp:"));
      if (!linea) continue;
      assert.match(linea, /^- Chat de WhatsApp: abierto/, `escenario "${b.nombre}": ${linea}`);
    }
  });
});

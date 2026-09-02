// La clave del dedup decide si el cron reconoce lo que ya trajo. Cuando se
// equivoca no tira excepción: inserta la misma actividad de nuevo, y el doctor
// queda con dos renglones iguales en el timeline y contando doble en las
// métricas del mes. Ya pasó: ×4 copias de 13 contact points el 20/8.
//
// Desde 0051 la clave además se congela en `activities.sync_key` con la fórmula
// SQL equivalente, así que estos casos también son el contrato con la base: si
// alguno cambia acá, el backfill de 0051 y el trigger `activities_set_sync_key`
// dejan de dar lo mismo y las notas corregidas se re-insertan.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { claveActividad } from "./actividades-sync";

const DOC = "11111111-1111-1111-1111-111111111111";

describe("claveActividad", () => {
  it("normaliza a UTC: la tarde de México no se va al día anterior", () => {
    // el bug del 20/8: los candidatos llegan en -06:00 y PostgREST devuelve UTC.
    // Un contacto de las 18:00 CDMX es el día siguiente en UTC, y comparar el
    // string crudo hacía que el dedup no lo viera.
    assert.equal(
      claveActividad(DOC, "2026-08-20T18:00:00-06:00", "Llamada"),
      `${DOC}|2026-08-21|Llamada`
    );
    assert.equal(
      claveActividad(DOC, "2026-08-20T09:00:00-06:00", "Llamada"),
      `${DOC}|2026-08-20|Llamada`
    );
  });

  it("la misma actividad da la misma clave venga en el huso que venga", () => {
    assert.equal(
      claveActividad(DOC, "2026-08-20T18:00:00-06:00", "Reunión"),
      claveActividad(DOC, "2026-08-21T00:00:00+00:00", "Reunión")
    );
  });

  it("corta el resumen a 80 CARACTERES, como el left() de Postgres", () => {
    // `left(summary, 80)` cuenta code points; `.slice(0, 80)` cuenta unidades
    // UTF-16, o sea que un emoji vale 2. Con `.slice` esta clave salía cortada
    // un carácter antes que la congelada en sync_key, y la primera corrección
    // de esa nota la duplicaba.
    const conEmoji = "Reunión 🎉 " + "a".repeat(100);
    const resumen = claveActividad(DOC, "2026-08-20T12:00:00Z", conEmoji).split("|")[2];
    assert.equal([...resumen].length, 80, "tiene que cortar por caracteres");
    assert.ok(resumen.includes("🎉"), "el emoji no se parte al medio");
  });

  it("un resumen corto entra entero", () => {
    assert.equal(
      claveActividad(DOC, "2026-08-20T12:00:00Z", "Habló con la doctora"),
      `${DOC}|2026-08-20|Habló con la doctora`
    );
  });

  it("dos resúmenes que solo difieren después del carácter 80 colisionan", () => {
    // No es un descuido: el corte existe para que un `details` larguísimo no
    // haga la clave impagable. Queda documentado que el precio es este.
    const base = "x".repeat(80);
    assert.equal(
      claveActividad(DOC, "2026-08-20T12:00:00Z", base + " primero"),
      claveActividad(DOC, "2026-08-20T12:00:00Z", base + " segundo")
    );
  });
});

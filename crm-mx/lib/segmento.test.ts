import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diasEntre, explicarSegmento, hace } from "./segmento";

const HOY = "2026-09-08";

describe("explicarSegmento", () => {
  test("activo: la acción y hace cuánto aprobó el último caso", () => {
    assert.equal(
      explicarSegmento(
        { segmento: "activo", ultimo_caso_aprobado_at: "2026-08-27", accredited_at: "2024-01-10" },
        HOY
      ),
      "Defender · último caso aprobado hace 12 días"
    );
  });

  test("lapsed: la misma frase, con meses cuando ya pasaron", () => {
    assert.equal(
      explicarSegmento(
        { segmento: "lapsed", ultimo_caso_aprobado_at: "2026-02-01", accredited_at: null },
        HOY
      ),
      "Conquistar · último caso aprobado hace 7 meses"
    );
  });

  test("beginner: cuántos días le quedan del plazo de 90", () => {
    assert.equal(
      explicarSegmento(
        { segmento: "beginner", ultimo_caso_aprobado_at: null, accredited_at: "2026-08-19" },
        HOY
      ),
      "Construir · 70 días para activarse"
    );
  });

  test("beginner en el día 90 exacto: quedan 0, no negativo", () => {
    assert.equal(
      explicarSegmento(
        { segmento: "beginner", ultimo_caso_aprobado_at: null, accredited_at: "2026-06-10" },
        HOY
      ),
      "Construir · 0 días para activarse"
    );
  });

  test("inactivo: sin fecha que explicar", () => {
    assert.equal(
      explicarSegmento(
        { segmento: "inactivo", ultimo_caso_aprobado_at: null, accredited_at: null },
        HOY
      ),
      "Observar · sin casos aprobados"
    );
  });

  test("sin estado (columna sin calcular): lo dice, no inventa una casilla", () => {
    assert.equal(
      explicarSegmento(
        { segmento: null, ultimo_caso_aprobado_at: null, accredited_at: null },
        HOY
      ),
      "Todavía sin calcular"
    );
  });

  test("la fecha puede venir como timestamp: se queda con el día", () => {
    assert.equal(
      explicarSegmento(
        {
          segmento: "activo",
          ultimo_caso_aprobado_at: "2026-09-07T06:00:00.000Z",
          accredited_at: null,
        },
        HOY
      ),
      "Defender · último caso aprobado ayer"
    );
  });
});

describe("hace / diasEntre", () => {
  test("los cortes de la frase", () => {
    assert.equal(hace(0), "hoy");
    assert.equal(hace(1), "ayer");
    assert.equal(hace(29), "hace 29 días");
    assert.equal(hace(30), "hace 1 mes");
    assert.equal(hace(364), "hace 11 meses");
    assert.equal(hace(365), "hace 1 año");
    assert.equal(hace(800), "hace 2 años");
  });

  test("diasEntre cuenta días de calendario", () => {
    assert.equal(diasEntre("2026-01-01", "2026-01-31"), 30);
    assert.equal(diasEntre("2026-09-08", "2026-09-08"), 0);
  });
});

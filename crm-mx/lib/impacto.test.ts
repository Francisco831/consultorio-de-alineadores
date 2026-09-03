import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  casosPorDoctor,
  primerToquePorPersona,
  relojDeDoctor,
  resumenTiers,
  serieCadencia,
  tierDe,
  ultimoMesCompleto,
  ventanaEspejo,
} from "./impacto";

const dia = (s: string) => Date.parse(`${s}T00:00:00Z`);
const JUAN = "11111111-1111-1111-1111-111111111111";

describe("relojDeDoctor", () => {
  test("con menos de 3 casos NO hay reloj: el doctor queda afuera, no se le inventa una base", () => {
    assert.equal(relojDeDoctor([dia("2026-01-01"), dia("2026-03-01")], dia("2026-09-01")), null);
  });

  test("la base es la mediana de los intervalos cerrados", () => {
    // gaps: 30 días (1/1→31/1) y 59 (31/1→31/3, febrero de 28) → mediana 44,5
    const f = [dia("2026-01-01"), dia("2026-01-31"), dia("2026-03-31")];
    const r = relojDeDoctor(f, dia("2026-04-10"));
    assert.ok(r);
    assert.equal(r.base, 44.5);
    assert.equal(r.estado, "al_dia"); // 10 días sobre una base de 44,5
  });

  test("los cuatro estados caen donde tienen que caer", () => {
    const f = [dia("2026-01-01"), dia("2026-01-31"), dia("2026-03-01")]; // gaps 30 y 29 → base 29,5
    const est = (corte: string) => relojDeDoctor(f, dia(corte))!.estado;
    assert.equal(est("2026-03-20"), "al_dia");   // 19 d ≤ 1,2×29,5
    assert.equal(est("2026-04-15"), "atrasado"); // 45 d
    assert.equal(est("2026-06-15"), "dormido");  // 106 d > 3×29,5
    assert.equal(est("2027-06-15"), "perdido");  // > 365 d
  });

  test("la base se acota: un doctor de un caso por semana no queda 'atrasado' a los 9 días", () => {
    const f = [dia("2026-01-01"), dia("2026-01-03"), dia("2026-01-05")]; // gaps de 2 días
    const r = relojDeDoctor(f, dia("2026-01-15"));
    assert.equal(r!.base, 14); // piso, no 2
  });
});

describe("serieCadencia", () => {
  test("solo meses completos y en orden", () => {
    const cd = casosPorDoctor([
      { doctor_id: "a", fecha_ingreso: "2026-01-01T00:00:00Z" },
      { doctor_id: "a", fecha_ingreso: "2026-02-01T00:00:00Z" },
      { doctor_id: "a", fecha_ingreso: "2026-03-01T00:00:00Z" },
    ]);
    const s = serieCadencia(cd, "2026-03", "2026-05");
    assert.deepEqual(s.map((p) => p.mes), ["2026-03", "2026-04", "2026-05"]);
    assert.equal(s[0].elegibles, 1);
  });

  test("ultimoMesCompleto no incluye el mes en curso, ni se le va el año en enero", () => {
    assert.equal(ultimoMesCompleto("2026-09-02"), "2026-08");
    assert.equal(ultimoMesCompleto("2026-01-15"), "2025-12");
  });
});

describe("resumenTiers", () => {
  const ahora = dia("2026-09-02");
  test("A/B/C por casos de los últimos 12 meses", () => {
    assert.equal(tierDe(4), "A");
    assert.equal(tierDe(3), "B");
    assert.equal(tierDe(0), "C");
  });

  test("la deuda NO se borra tocando al doctor: el contacto es columna, no criterio", () => {
    // doctor con ritmo de ~30 días y 5 meses sin caso → dormido y en deuda
    const cd = casosPorDoctor([
      { doctor_id: "a", fecha_ingreso: "2026-01-01T00:00:00Z" },
      { doctor_id: "a", fecha_ingreso: "2026-02-01T00:00:00Z" },
      { doctor_id: "a", fecha_ingreso: "2026-03-01T00:00:00Z" },
    ]);
    const sinTocar = resumenTiers(cd, new Map(), ahora);
    const tocado = resumenTiers(cd, new Map([["a", dia("2026-09-01")]]), ahora);
    const deudaDe = (f: ReturnType<typeof resumenTiers>) =>
      f.reduce((a, x) => a + x.deuda, 0);
    assert.equal(deudaDe(sinTocar), 1);
    assert.equal(deudaDe(tocado), 1, "diez WhatsApp no pueden borrar la deuda");
    assert.equal(tocado.reduce((a, x) => a + x.tocados30d, 0), 1);
  });
});

describe("ventanaEspejo", () => {
  const ahora = dia("2026-09-02");
  test("compara la ventana real contra la misma ventana un año antes", () => {
    const cd = casosPorDoctor([
      // un año antes: 2 casos antes del toque, 0 después
      { doctor_id: "a", fecha_ingreso: "2024-12-01T00:00:00Z" },
      { doctor_id: "a", fecha_ingreso: "2024-12-20T00:00:00Z" },
      // real: 0 antes, 2 después
      { doctor_id: "a", fecha_ingreso: "2026-01-10T00:00:00Z" },
      { doctor_id: "a", fecha_ingreso: "2026-02-10T00:00:00Z" },
    ]);
    const e = ventanaEspejo(new Map([["a", dia("2026-01-01")]]), JUAN, cd, ahora);
    assert.equal(e.doctores, 1);
    assert.equal(e.antes, 0);
    assert.equal(e.despues, 2);
    assert.equal(e.suben, 1);
    assert.equal(e.antesPlacebo, 2);
    assert.equal(e.despuesPlacebo, 0);
    assert.equal(e.subenPlacebo, 0);
  });

  test("un doctor tocado hace dos semanas no entra: no tiene 'después' todavía", () => {
    const cd = casosPorDoctor([{ doctor_id: "a", fecha_ingreso: "2026-08-25T00:00:00Z" }]);
    const e = ventanaEspejo(new Map([["a", dia("2026-08-20")]]), JUAN, cd, ahora);
    assert.equal(e.doctores, 0);
  });
});

describe("primerToquePorPersona", () => {
  test("se queda con el PRIMER contacto y descarta lo que no es contacto", () => {
    const m = primerToquePorPersona([
      { doctor_id: "a", created_by: JUAN, occurred_at: "2026-03-01T00:00:00Z", type: "llamada" },
      { doctor_id: "a", created_by: JUAN, occurred_at: "2026-01-01T00:00:00Z", type: "visita" },
      { doctor_id: "a", created_by: JUAN, occurred_at: "2025-01-01T00:00:00Z", type: "nota" },
      { doctor_id: "a", created_by: JUAN, occurred_at: "2025-01-01T00:00:00Z", type: "revision_clinica" },
    ]);
    assert.equal(m.get(JUAN)!.get("a"), dia("2026-01-01"));
  });
});

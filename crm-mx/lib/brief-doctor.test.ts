// El brief se lee 30 segundos antes de atender una llamada: si miente, la
// llamada arranca mal. Lo que se prueba acá es justamente eso — que con datos
// completos diga lo que hay, y que con la ficha vacía NO invente nada.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { briefDoctor, type DatosBrief } from "./brief-doctor";
import { todayMX } from "./dates";

/** ISO de las 09:00 de México de hace n días — así el test no caduca mañana */
function haceDias(n: number): string {
  const [y, m, d] = todayMX().split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) - n * 86_400_000;
  return `${new Date(t).toISOString().slice(0, 10)}T15:00:00.000Z`;
}

/** YYYY-MM-DD de hace n días (events.fecha es `date`, sin hora) */
function fechaHaceDias(n: number): string {
  return haceDias(n).slice(0, 10);
}

const VACIO: DatosBrief = {
  nombre: "María Pérez",
  categoria: null,
  city: null,
  state: null,
  zona: null,
  case_count: null,
  new_case_count: null,
  last_contact_at: null,
  avg_interval_days: null,
  instagram: null,
  specialty: null,
  uses_aligners: null,
  estimated_cases_month: null,
  why_interesting: null,
  competitor_brands: null,
  tiposTratamiento: null,
  eventos: null,
  lifecycle_stage: null,
};

describe("briefDoctor", () => {
  it("doctor completo: quién es, qué pasó y con qué abrir", () => {
    const brief = briefDoctor({
      ...VACIO,
      nombre: "Gabriela Cisneros",
      categoria: "GOLD",
      city: "Chihuahua",
      state: "Chihuahua",
      case_count: 36,
      new_case_count: 26,
      last_contact_at: haceDias(9),
      avg_interval_days: 21,
      instagram: "gabyortho",
      specialty: "Ortodoncia",
      tiposTratamiento: ["Full", "Fast"],
      eventos: [{ titulo: "KeepDay Monterrey", fecha: fechaHaceDias(20) }],
      lifecycle_stage: "activo",
      why_interesting: "Da clases y arrastra colegas de su generación",
    });

    assert.equal(brief.length, 3);
    assert.match(brief[0], /Gabriela Cisneros/);
    assert.match(brief[0], /Gold de Chihuahua/);
    assert.match(brief[0], /36 casos/);
    assert.match(brief[0], /26 nuevos/);
    assert.match(brief[0], /@gabyortho/);
    assert.match(brief[1], /Último contacto hace 9 días/);
    assert.match(brief[1], /cada 21 días/);
    assert.match(brief[1], /Full y Fast/);
    assert.match(brief[1], /KeepDay Monterrey/);
    // 9 días con ritmo de 21 NO es atraso: gana why_interesting
    assert.match(brief[2], /Da clases y arrastra colegas/);
    for (const o of brief) assert.ok(o.endsWith("."), `sin punto final: ${o}`);
  });

  it("ficha vacía: no inventa nada y lo dice", () => {
    const brief = briefDoctor(VACIO);

    assert.equal(brief.length, 3);
    assert.match(brief[0], /María Pérez/);
    assert.match(brief[0], /no tiene categoría, ubicación ni casos/);
    assert.equal(brief[1], "Sin contactos, casos ni eventos registrados en el CRM.");
    assert.equal(
      brief[2],
      "Poca información cargada: arrancá preguntando cómo viene el mes."
    );
    // la prueba de fuego: ningún número aparece de la nada
    for (const o of brief) assert.doesNotMatch(o, /\d/, `apareció un número inventado: ${o}`);
  });

  it("atrasado contra su propio ritmo: eso manda sobre el resto", () => {
    const brief = briefDoctor({
      ...VACIO,
      nombre: "Luis Cuatepotzo",
      categoria: "SILVER",
      state: "Puebla",
      case_count: 12,
      last_contact_at: haceDias(60),
      avg_interval_days: 20,
      // hay why_interesting y marca de la competencia, y aun así gana el atraso
      why_interesting: "Preguntó por el curso de acreditación",
      competitor_brands: ["Invisalign"],
    });

    assert.match(brief[2], /atrasado/);
    assert.match(brief[2], /60 días sin contacto/);
    assert.match(brief[2], /20 habituales/);
    assert.doesNotMatch(brief[2], /Invisalign/);
  });

  it("ficha llena sin palanca: NO dice 'poca información cargada'", () => {
    // el caso real de Flores Heredia (46 casos, contacto de la semana pasada):
    // no está atrasada ni hay nada anotado, pero decirle "poca información" a
    // una ficha así es mentir
    const brief = briefDoctor({
      ...VACIO,
      nombre: "Mayra Flores",
      case_count: 46,
      last_contact_at: haceDias(6),
      avg_interval_days: 16,
      tiposTratamiento: ["ESTANDAR", "SUPERPOSICION"],
    });

    assert.doesNotMatch(brief[2], /Poca información/);
    assert.match(brief[2], /al día con su propio ritmo/);
    // y los tipos de Noloco dejan de gritar en mayúsculas
    assert.match(brief[1], /Estandar y Superposicion/);
  });

  it("prospecto sin casos: usa la etapa y lo estimado, no un cero seco", () => {
    const brief = briefDoctor({
      ...VACIO,
      nombre: "Ana Domench",
      case_count: 0,
      lifecycle_stage: "prospecto",
      estimated_cases_month: 8,
      uses_aligners: true,
      competitor_brands: ["Smile Direct"],
    });

    assert.match(brief[0], /prospecto/);
    assert.match(brief[0], /estima 8 casos por mes/);
    assert.match(brief[2], /Smile Direct/);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  agruparPorDia,
  canonTel,
  diaLocal,
  esDelEquipo,
  indexarDoctores,
  matchearDoctor,
  sinTelefonos,
  textoAvisoSlack,
  tokensNombre,
  transcripcion,
  type Chat,
} from "./directo";

const DOCTORES = [
  { id: "d1", nombre: "Diaz Mendoza Xilonen", phone: "+525511223344", whatsapp: "+525511223344", is_accredited: true, case_count: 7 },
  { id: "d2", nombre: "Odontopediatra Xilonen Díaz", phone: null, whatsapp: null, is_accredited: false, case_count: 0 },
  { id: "d3", nombre: "Mejía Díaz Iván", phone: "5215512345678", whatsapp: null, is_accredited: true, case_count: 3 },
  { id: "d4", nombre: "Mejía Iván", phone: null, whatsapp: null, is_accredited: false, case_count: 0 },
  { id: "d5", nombre: "López Verónica", phone: "+523312496634", whatsapp: null, is_accredited: true, case_count: 2 },
];

function chat(over: Partial<Chat>): Chat {
  return {
    chat_id: "120363000000000001@g.us",
    nombre: "Grupo",
    es_grupo: true,
    mensajes: [],
    ...over,
  };
}

describe("teléfonos", () => {
  test("canonTel colapsa 521 y agrega 52 a 10 dígitos", () => {
    assert.equal(canonTel("+52 1 55 1122 3344"), "525511223344");
    assert.equal(canonTel("5511223344"), "525511223344");
    assert.equal(canonTel("+525511223344"), "525511223344");
    assert.equal(canonTel("abc"), null);
  });
  test("sinTelefonos tapa números antes de que viajen al modelo", () => {
    assert.equal(sinTelefonos("llamame al +52 1 55 1122 3344 hoy"), "llamame al [tel] hoy");
    assert.equal(sinTelefonos("son 3 alineadores"), "son 3 alineadores");
  });
});

describe("matchearDoctor", () => {
  const idx = indexarDoctores(DOCTORES);

  test("por teléfono del contacto (chat 1:1), con y sin el 1 móvil", () => {
    const m = matchearDoctor(chat({ chat_id: "5215511223344@c.us", es_grupo: false, nombre: "Xilo" }), idx);
    assert.equal(m.doctor?.id, "d1");
    assert.equal(m.via, "telefono");
  });

  test("por nombre del grupo 'Nombre Apellido & KeepSmiling' contra 'Apellido Nombre'", () => {
    const m = matchearDoctor(chat({ nombre: "Xilonen Diaz Mendoza & KeepSmiling" }), idx);
    assert.equal(m.doctor?.id, "d1");
    assert.equal(m.via, "nombre");
  });

  test("acentos no importan y el acreditado con casos gana el empate", () => {
    const m = matchearDoctor(chat({ nombre: "Ivan Mejia Diaz & KeepSmiling" }), idx);
    assert.equal(m.doctor?.id, "d3");
  });

  test("dos fichas equivalentes = ambiguo, no se adivina", () => {
    const idx2 = indexarDoctores([
      { id: "a", nombre: "Pérez Juan", phone: null, whatsapp: null, is_accredited: false, case_count: 0 },
      { id: "b", nombre: "Pérez Juan", phone: null, whatsapp: null, is_accredited: false, case_count: 0 },
    ]);
    const m = matchearDoctor(chat({ nombre: "Juan Perez & KeepSmiling" }), idx2);
    assert.equal(m.doctor, null);
    assert.equal(m.via, "ambiguo");
  });

  test("por participante del grupo cuando el nombre no dice nada", () => {
    const m = matchearDoctor(chat({ nombre: "Caso urgente", participantes: ["+52 1 33 1249 6634", "+54 9 11 2374 0762"] }), idx);
    assert.equal(m.doctor?.id, "d5");
    assert.equal(m.via, "participante");
  });

  test("un nombre de una sola palabra no matchea a nadie", () => {
    const m = matchearDoctor(chat({ nombre: "Verónica" }), idx);
    assert.equal(m.doctor, null);
    assert.equal(m.via, "sin_match");
  });

  test("tokensNombre saca el ruido", () => {
    assert.deepEqual(tokensNombre("Dra. Xilonen Diaz Mendoza & KeepSmiling"), ["xilonen", "diaz", "mendoza"]);
  });
});

describe("equipo, días y transcripción", () => {
  test("un mensaje de la línea de Juan cuenta como nuestro", () => {
    assert.equal(esDelEquipo({ id: "x", ts: "2026-09-08T20:00:00Z", from_me: false, autor: "+52 1 55 1068 5144", autor_tel: "+52 1 55 1068 5144" }), true);
    assert.equal(esDelEquipo({ id: "x", ts: "2026-09-08T20:00:00Z", from_me: false, autor: "Xilonen Diaz Mendoza" }), false);
    assert.equal(esDelEquipo({ id: "x", ts: "2026-09-08T20:00:00Z", from_me: true }), true);
  });

  test("el día es el de México: las 02:00Z del 9 siguen siendo el 8", () => {
    assert.equal(diaLocal("2026-09-09T02:00:00Z"), "2026-09-08");
    assert.equal(diaLocal("2026-09-09T07:00:00Z"), "2026-09-09");
  });

  test("agruparPorDia ordena y separa", () => {
    const g = agruparPorDia([
      { id: "b", ts: "2026-09-09T07:00:00Z", from_me: true, texto: "hola" },
      { id: "a", ts: "2026-09-08T20:00:00Z", from_me: false, texto: "buenas" },
    ]);
    assert.deepEqual([...g.keys()], ["2026-09-08", "2026-09-09"]);
  });

  test("la transcripción no lleva teléfonos y marca KS", () => {
    const t = transcripcion([
      { id: "1", ts: "2026-09-08T18:00:00Z", from_me: false, autor: "Dra X", texto: "mi cel es 55 1122 3344" },
      { id: "2", ts: "2026-09-08T18:05:00Z", from_me: true, texto: "listo", tipo: "chat" },
      { id: "3", ts: "2026-09-08T18:06:00Z", from_me: false, autor: "Dra X", tipo: "image" },
    ]);
    assert.match(t, /12:00 Dra X: mi cel es \[tel\]/);
    assert.match(t, /12:05 KS: listo/);
    assert.match(t, /12:06 Dra X: \[image\]/);
  });
});

describe("aviso a Slack", () => {
  test("nombra doctores, pendientes y sin ficha", () => {
    const texto = textoAvisoSlack({
      linea: "5491123740762",
      leido_hasta: "2026-09-08T23:00:00Z",
      dry_run: false,
      costo_usd: 0.12,
      chats: [
        { chat_id: "a@g.us", nombre: "X & KS", es_grupo: true, doctor: { id: "d1", nombre: "Diaz Mendoza Xilonen" }, via: "nombre", mensajes_nuevos: 4, ultimo_es_nuestro: false, espera_respuesta: true, resumen: "Pidió viabilidad de una paciente.", pedidos: [{ titulo: "Enviar viabilidad", tipo: "seguimiento", vence: "2026-09-10" }] },
        { chat_id: "b@c.us", nombre: "Ivan Contreras", es_grupo: false, doctor: null, via: "sin_match", mensajes_nuevos: 2, ultimo_es_nuestro: true, espera_respuesta: false, resumen: null, pedidos: [] },
        { chat_id: "c@c.us", nombre: "Nadie", es_grupo: false, doctor: null, via: "sin_match", mensajes_nuevos: 0, ultimo_es_nuestro: true, espera_respuesta: false, resumen: null, pedidos: [] },
      ],
    });
    assert.match(texto, /1 doctor con conversación/);
    assert.match(texto, /Diaz Mendoza Xilonen> — Pidió viabilidad de una paciente\. ⚠️ espera respuesta · 1 tarea propuesta/);
    assert.match(texto, /Esperan respuesta nuestra:\* 1/);
    assert.match(texto, /Sin ficha en el CRM \(1\):\* Ivan Contreras/);
    assert.match(texto, /USD 0\.12/);
  });

  test("sin novedades lo dice", () => {
    const texto = textoAvisoSlack({ linea: "5491123740762", leido_hasta: "2026-09-08T23:00:00Z", dry_run: false, costo_usd: 0, chats: [] });
    assert.match(texto, /Sin mensajes nuevos/);
  });
});

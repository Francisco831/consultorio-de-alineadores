import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PARAMS_INTERACCION_DEFAULT,
  explicarInteraccion,
  leerParamsInteraccion,
  sugerenciaCruce,
} from "./interaccion";

const HOY = "2026-09-08";

describe("leerParamsInteraccion", () => {
  test("sin fila en la base: los valores iniciales de 0060", () => {
    assert.deepEqual(leerParamsInteraccion(null), PARAMS_INTERACCION_DEFAULT);
    assert.deepEqual(leerParamsInteraccion(undefined), PARAMS_INTERACCION_DEFAULT);
    assert.deepEqual(leerParamsInteraccion("basura"), PARAMS_INTERACCION_DEFAULT);
  });

  test("lo que llega de un formulario son strings, y se leen como números", () => {
    const p = leerParamsInteraccion({
      dias: "60",
      min_del_doctor: "5",
      min_nuestros: "2",
      min_dias: "3",
      min_contactos: "0",
      linea: "+54 9 11 2374-0762",
      tipos_contacto: ["llamada", "reunion"],
    });
    assert.equal(p.dias, 60);
    assert.equal(p.min_del_doctor, 5);
    assert.equal(p.min_nuestros, 2);
    assert.equal(p.min_dias, 3);
    assert.equal(p.min_contactos, 0);
    assert.equal(p.linea, "5491123740762");
    assert.deepEqual(p.tipos_contacto, ["llamada", "reunion"]);
  });

  test("lo que no es número toma el default; lo que se pasa de rango se recorta", () => {
    const p = leerParamsInteraccion({ dias: "muchos", min_del_doctor: -4, min_dias: 99999 });
    assert.equal(p.dias, 90);
    assert.equal(p.min_del_doctor, 0);
    assert.equal(p.min_dias, 3650);
  });

  test("línea vacía = todas las líneas; línea inválida vuelve al default", () => {
    assert.equal(leerParamsInteraccion({ linea: "" }).linea, null);
    assert.equal(leerParamsInteraccion({ linea: "   " }).linea, null);
    assert.equal(leerParamsInteraccion({ linea: "123" }).linea, "5491123740762");
    assert.equal(leerParamsInteraccion({}).linea, "5491123740762");
  });

  test("tipos: solo los que existen, sin repetir; un array vacío es una elección", () => {
    assert.deepEqual(
      leerParamsInteraccion({ tipos_contacto: ["llamada", "inventado", "llamada", "keepday"] })
        .tipos_contacto,
      ["llamada", "keepday"]
    );
    assert.deepEqual(leerParamsInteraccion({ tipos_contacto: [] }).tipos_contacto, []);
    assert.deepEqual(
      leerParamsInteraccion({ tipos_contacto: "llamada" }).tipos_contacto,
      PARAMS_INTERACCION_DEFAULT.tipos_contacto
    );
  });
});

describe("explicarInteraccion", () => {
  test("con mensajes y contactos: los números y hace cuánto fue el último WhatsApp", () => {
    assert.equal(
      explicarInteraccion(
        {
          interaccion: "real",
          wa_del_doctor: 12,
          wa_nuestros: 8,
          wa_dias: 3,
          contactos_registrados: 1,
          ultimo_wa_at: "2026-09-06",
        },
        { dias: 90 },
        HOY
      ),
      "12 mensajes del doctor y 8 nuestros en 3 días · 1 contacto registrado en 90 días · último WhatsApp hace 2 días"
    );
  });

  test("sin nada en la ventana, lo dice; y el singular es singular", () => {
    assert.equal(
      explicarInteraccion(
        {
          interaccion: "sin_contacto",
          wa_del_doctor: 0,
          wa_nuestros: 0,
          wa_dias: 0,
          contactos_registrados: 0,
          ultimo_wa_at: null,
        },
        { dias: 60 },
        HOY
      ),
      "sin mensajes por la línea de soporte · sin contactos registrados en 60 días"
    );
    assert.equal(
      explicarInteraccion(
        {
          interaccion: "puntual",
          wa_del_doctor: 1,
          wa_nuestros: 0,
          wa_dias: 1,
          contactos_registrados: 0,
          ultimo_wa_at: HOY,
        },
        { dias: 90 },
        HOY
      ),
      "1 mensaje del doctor y 0 nuestros en 1 día · sin contactos registrados en 90 días · último WhatsApp hoy"
    );
  });

  test("sin calcular", () => {
    assert.equal(
      explicarInteraccion(
        {
          interaccion: null,
          wa_del_doctor: 0,
          wa_nuestros: 0,
          wa_dias: 0,
          contactos_registrados: 0,
          ultimo_wa_at: null,
        },
        { dias: 90 },
        HOY
      ),
      "Todavía sin calcular"
    );
  });
});

describe("sugerenciaCruce: las tres casillas del pedido", () => {
  test("activo sin interacción real → fortalecer el vínculo", () => {
    assert.match(sugerenciaCruce("activo", "sin_contacto"), /^Fortalecer el vínculo · solo transaccional/);
    assert.match(sugerenciaCruce("activo", "puntual"), /^Fortalecer el vínculo/);
  });

  test("inactivo sin contacto → prioridad de acercamiento", () => {
    assert.match(sugerenciaCruce("inactivo", "sin_contacto"), /^Acercamiento prioritario/);
    assert.match(sugerenciaCruce("inactivo", "sin_contacto"), /qué necesita o qué está fallando/);
  });

  test("inactivo con buena interacción → el problema no es de vínculo", () => {
    assert.match(sugerenciaCruce("inactivo", "real"), /no es de vínculo/);
  });

  test("todas las casillas tienen texto con la forma Acción · lectura", () => {
    for (const s of ["activo", "lapsed", "beginner", "inactivo"] as const) {
      for (const i of ["real", "puntual", "sin_contacto"] as const) {
        assert.match(sugerenciaCruce(s, i), /^[^·]+ · [^·]+/);
      }
    }
  });

  test("sin alguno de los dos ejes, no se inventa", () => {
    assert.equal(sugerenciaCruce(null, "real"), "Todavía sin calcular");
    assert.equal(sugerenciaCruce("activo", null), "Todavía sin calcular");
  });
});

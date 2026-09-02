// Pruebas del guard de destino compartido (scripts/lib/destino.ts).
//
// Cada bloque nombra el accidente concreto que evita. Los tres primeros son la
// reconstrucción de agujeros reales que existían hasta el 13/8/2026.
//
//   npm test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { refAmbiguo, necesitaConfirmacion, refDeLaUrl, refConfirmadoValido } from "./lib/destino";
import { resolverEntorno } from "./lib/migrate-core";

const DEV = "klujlknadykmsgatqtks";
const PROD = "yuxfgbbqhqquuoaudjdd";
const registro = { [DEV]: "desarrollo", [PROD]: "produccion" };

describe("refDeLaUrl", () => {
  it("saca el ref del proyecto de la URL de Supabase", () => {
    assert.equal(refDeLaUrl(`https://${DEV}.supabase.co`), DEV);
    assert.equal(refDeLaUrl(`http://${PROD}.supabase.co`), PROD);
  });
});

describe("refAmbiguo", () => {
  it("frena la trampa de SUPABASE_PROJECT_REF: pedís prod y la URL es dev", () => {
    // docs/PUESTA_AL_DIA_PROD.md documenta `SUPABASE_PROJECT_REF=<ref> npx tsx
    // scripts/...`, pero esa variable la leen SOLO lib/pg.ts y el runner. Los
    // importadores usan supabase-js, que va por la URL: quien seguía el
    // procedimiento oficial creía escribir en producción y escribía en desarrollo.
    const msg = refAmbiguo(DEV, PROD, undefined);
    assert.ok(msg, "tiene que frenar");
    assert.match(msg!, /Destino ambiguo/);
    assert.match(msg!, new RegExp(PROD));
    assert.match(msg!, new RegExp(DEV));
  });

  it("no molesta cuando las dos fuentes coinciden", () => {
    assert.equal(refAmbiguo(DEV, DEV, undefined), null);
  });

  it("sin SUPABASE_PROJECT_REF no hay ambigüedad que reportar", () => {
    assert.equal(refAmbiguo(DEV, undefined, undefined), null);
  });

  it("los scripts que conectan por pg SÍ honran la variable: para ellos no es ambiguo", () => {
    // lib/pg.ts resuelve `SUPABASE_PROJECT_REF ?? url`, así que ahí la variable
    // no miente. Rechazarla rompería un procedimiento que hoy funciona.
    assert.equal(refAmbiguo(DEV, PROD, PROD), null);
  });
});

describe("necesitaConfirmacion", () => {
  const dev = resolverEntorno(DEV, registro);
  const prod = resolverEntorno(PROD, registro);
  const desconocido = resolverEntorno("refquenadieregistro", registro);

  it("la corrida de todos los días no pregunta nada", () => {
    assert.equal(
      necesitaConfirmacion(dev.entorno, dev.exigeConfirmacionManual, false),
      false
    );
  });

  it("PRODUCCIÓN siempre pregunta, aunque esté registrada", () => {
    // Registrar producción en environments.json se hizo para protegerla y tenía
    // el efecto contrario: la volvía "conocida" y con eso habilitaba --yes.
    assert.equal(
      necesitaConfirmacion(prod.entorno, prod.exigeConfirmacionManual, false),
      true
    );
  });

  it("un destino desconocido pregunta", () => {
    assert.equal(
      necesitaConfirmacion(
        desconocido.entorno,
        desconocido.exigeConfirmacionManual,
        false
      ),
      true
    );
  });

  it("lo que BORRA pregunta incluso en desarrollo", () => {
    // limpiar-basura, merge-prospect-dups y remove-itzel borran filas. Perder la
    // base de desarrollo también cuesta un día de trabajo.
    assert.equal(
      necesitaConfirmacion(dev.entorno, dev.exigeConfirmacionManual, true),
      true
    );
  });
});

describe("refConfirmadoValido", () => {
  // GitHub Actions no tiene terminal: la confirmación escrita entra por
  // argumento. La vara es la misma que tipearla: el ref exacto y nada más.
  it("acepta el ref exacto (con espacios alrededor, que el formulario agrega)", () => {
    assert.equal(refConfirmadoValido(PROD, PROD), true);
    assert.equal(refConfirmadoValido(PROD, `  ${PROD}\n`), true);
  });
  it("rechaza cualquier otra cosa: otro ref, un prefijo, 'yes', vacío", () => {
    assert.equal(refConfirmadoValido(PROD, DEV), false);
    assert.equal(refConfirmadoValido(PROD, PROD.slice(0, 8)), false);
    assert.equal(refConfirmadoValido(PROD, "yes"), false);
    assert.equal(refConfirmadoValido(PROD, ""), false);
    assert.equal(refConfirmadoValido(PROD, undefined), false);
    assert.equal(refConfirmadoValido("", ""), false);
  });
});

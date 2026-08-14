// Pruebas de las decisiones del runner de migraciones.
//
//   npm test
//
// No tocan la red ni ninguna base: prueban las funciones puras de
// scripts/lib/migrate-core.ts. Cada bloque nombra el error real que evita.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import {
  checksum,
  claveLedger,
  compararConLedger,
  esArchivoDeMigracion,
  esRollback,
  MODOS,
  MODOS_SIN_ESCRITURA,
  ordenarMigraciones,
  prefijo,
  QUE_HACE,
  refEfectivo,
  resolverEntorno,
  resolverModo,
} from "./lib/migrate-core";

describe("resolverModo", () => {
  it("sin modo explícito NO aplica: el default es dry-run", () => {
    // Éste es el incidente del 10/8/2026: correr el runner "a ver qué imprime"
    // no puede escribir en una base con datos reales.
    assert.deepEqual(resolverModo([]), { modo: "dry-run" });
    assert.deepEqual(resolverModo(["archivo.sql"]), { modo: "dry-run" });
    assert.deepEqual(resolverModo(["--yes"]), { modo: "dry-run" });
  });

  it("reconoce cada modo", () => {
    assert.deepEqual(resolverModo(["--apply"]), { modo: "apply" });
    assert.deepEqual(resolverModo(["--print-target"]), { modo: "print-target" });
    assert.deepEqual(resolverModo(["--check-connection"]), { modo: "check-connection" });
    assert.deepEqual(resolverModo(["--dry-run"]), { modo: "dry-run" });
    assert.deepEqual(resolverModo(["--ensayo"]), { modo: "ensayo" });
  });

  it("rechaza dos modos en vez de elegir uno", () => {
    const r = resolverModo(["--dry-run", "--apply"]);
    assert.ok("error" in r, "debería ser un error");
    assert.match(r.error, /incompatibles/);
  });

  it("--ensayo tampoco se combina con --apply", () => {
    // Los dos corren el SQL; solo cambia si al final hay commit. Confundirlos sería
    // el peor error posible del runner, así que se rechaza en vez de desempatar.
    assert.ok("error" in resolverModo(["--ensayo", "--apply"]));
    assert.ok("error" in resolverModo(["--ensayo", "--dry-run"]));
  });

  it("todo modo tiene su descripción, y los que no escriben están declarados", () => {
    // Si alguien agrega un modo y se olvida de QUE_HACE, el runner imprimiría
    // "undefined" en el recuadro del destino, que es justo donde no se puede dudar.
    for (const m of MODOS) {
      assert.equal(typeof QUE_HACE[m], "string", `falta QUE_HACE para --${m}`);
      assert.ok(QUE_HACE[m].length > 0);
    }
    // Un modo nuevo que no escriba tiene que declararse acá; si no, el default
    // seguro deja de ser verdad.
    for (const m of MODOS_SIN_ESCRITURA) assert.ok(MODOS.includes(m));
    assert.ok(!MODOS_SIN_ESCRITURA.includes("apply" as never));
    assert.ok(!MODOS_SIN_ESCRITURA.includes("sembrar" as never));
  });
});

describe("resolverEntorno", () => {
  const registro = { devref: "desarrollo", prodref: "produccion" };

  it("identifica los refs registrados", () => {
    assert.equal(resolverEntorno("devref", registro).entorno, "desarrollo");
    assert.equal(resolverEntorno("prodref", registro).entorno, "produccion");
  });

  it("un ref desconocido NO se asume desarrollo", () => {
    // El host del pooler es idéntico para dev y prod. Adivinar acá es el camino
    // corto para escribir en producción creyendo que es dev.
    const d = resolverEntorno("refquenadieregistró", registro);
    assert.equal(d.entorno, "desconocido");
    assert.equal(d.exigeConfirmacionManual, true);
  });

  it("un ref desconocido no se destraba con --yes", () => {
    assert.equal(resolverEntorno("otro", {}).exigeConfirmacionManual, true);
    // desarrollo sí: es el destino donde --yes tiene sentido
    assert.equal(resolverEntorno("devref", registro).exigeConfirmacionManual, false);
  });

  it("producción exige confirmación SIEMPRE, aunque esté registrada", () => {
    // Esta prueba fijaba lo contrario. Registrar producción en environments.json
    // se hizo para protegerla, y tenía el efecto exacto opuesto: la declaraba
    // "conocida" y con eso habilitaba `--apply --yes` sin una sola pregunta.
    assert.equal(resolverEntorno("prodref", registro).exigeConfirmacionManual, true);
  });

  it("acepta SUPABASE_DEV_REF por compatibilidad, y lo dice", () => {
    const d = resolverEntorno("suelto", {}, "suelto");
    assert.equal(d.entorno, "desarrollo");
    assert.match(d.fuente, /SUPABASE_DEV_REF/);
  });

  it("SUPABASE_DEV_REF no puede contradecir al registro", () => {
    // Si el registro dice que es producción, una variable de entorno mal puesta
    // no lo convierte en desarrollo.
    const d = resolverEntorno("prodref", registro, "prodref");
    assert.equal(d.entorno, "produccion");
  });

  it("un valor inválido en el registro se trata como desconocido, no como válido", () => {
    const d = resolverEntorno("x", { x: "staging-ish" });
    assert.equal(d.entorno, "desconocido");
    assert.equal(d.exigeConfirmacionManual, true);
  });
});

describe("checksum", () => {
  it("es estable y distingue contenidos", () => {
    assert.equal(checksum("select 1;"), checksum("select 1;"));
    assert.notEqual(checksum("select 1;"), checksum("select 2;"));
  });

  it("ignora CRLF: un editor no debería marcar la migración como divergente", () => {
    assert.equal(checksum("a\r\nb\r\n"), checksum("a\nb\n"));
  });

  it("no ignora cambios reales de espaciado", () => {
    assert.notEqual(checksum("select 1;"), checksum("select  1;"));
  });
});

describe("esArchivoDeMigracion", () => {
  it("excluye los rollbacks", () => {
    // Vivían en supabase/migrations/ y una corrida sin argumentos aplicaba
    // 0027_function_grants.sql e inmediatamente después su propio rollback.
    assert.equal(esArchivoDeMigracion("0027_function_grants.sql"), true);
    assert.equal(esArchivoDeMigracion("0027_function_grants_rollback.sql"), false);
    assert.equal(esArchivoDeMigracion("0027_function_grants_ROLLBACK.SQL"), false);
  });

  it("excluye lo que no es .sql", () => {
    assert.equal(esArchivoDeMigracion("README.md"), false);
    assert.equal(esArchivoDeMigracion(".DS_Store"), false);
  });

  it("no se le escapa un .SQL en mayúsculas", () => {
    assert.equal(esArchivoDeMigracion("0030_ALGO.SQL"), true);
  });
});

describe("esRollback", () => {
  it("reconoce el sufijo y el directorio", () => {
    assert.equal(esRollback("supabase/rollbacks/0028_migration_ledger_rollback.sql"), true);
    assert.equal(esRollback("supabase/rollbacks/cualquier_cosa.sql"), true);
    assert.equal(esRollback("supabase/migrations/0028_migration_ledger.sql"), false);
  });

  it("el rollback de 0028 tiene que quedar fuera del ledger", () => {
    // Anotarlo era imposible ADEMÁS de incorrecto: el rollback borra
    // ops.schema_migrations, así que el insert posterior fallaba, abortaba la
    // transacción y revertía el propio rollback.
    assert.equal(esRollback("supabase/rollbacks/0028_migration_ledger_rollback.sql"), true);
  });
});

describe("claveLedger", () => {
  it("la misma migración con distinta ruta es UNA sola fila", () => {
    const a = claveLedger("supabase/migrations/0001_x.sql");
    const b = claveLedger("./supabase/migrations/0001_x.sql");
    const c = claveLedger("/abs/crm-mx/supabase/migrations/0001_x.sql");
    assert.equal(a, "0001_x.sql");
    assert.equal(b, a);
    assert.equal(c, a);
  });
});

describe("prefijo", () => {
  it("lee el número aunque venga con ruta", () => {
    assert.equal(prefijo("supabase/migrations/0027_function_grants.sql"), 27);
    assert.equal(prefijo("0001_x.sql"), 1);
    assert.equal(prefijo("fix.sql"), null);
  });
});

describe("refEfectivo", () => {
  it("sin SUPABASE_DB_USER manda la URL", () => {
    assert.deepEqual(refEfectivo("devref"), { ref: "devref", discrepancia: null });
  });

  it("contra el pooler manda el usuario, no la URL", () => {
    // Es el agujero: con SUPABASE_DB_USER=postgres.prodref y la URL de dev, el
    // runner conectaba a producción anunciando "DESARROLLO" y aplicaba sin preguntar.
    const r = refEfectivo("devref", "postgres.prodref");
    assert.equal(r.ref, "prodref");
    assert.ok(r.discrepancia, "tiene que avisar de la discrepancia");
  });

  it("si coinciden, no inventa discrepancia", () => {
    assert.equal(refEfectivo("devref", "postgres.devref").discrepancia, null);
  });

  it("un usuario que no es postgres.<ref> no cambia nada", () => {
    assert.deepEqual(refEfectivo("devref", "postgres"), { ref: "devref", discrepancia: null });
  });
});

describe("modo sembrar", () => {
  it("existe como modo propio", () => {
    assert.deepEqual(resolverModo(["--sembrar"]), { modo: "sembrar" });
  });

  it("sigue siendo incompatible con los otros", () => {
    assert.ok("error" in resolverModo(["--sembrar", "--apply"]));
  });
});

describe("ordenarMigraciones", () => {
  it("ordena por número, no alfabéticamente", () => {
    // Con .sort() a secas, 0100 va antes que 0099 apenas el proyecto pase de 99.
    const { orden } = ordenarMigraciones(["0100_z.sql", "0099_a.sql", "0002_b.sql"]);
    assert.deepEqual(orden, ["0002_b.sql", "0099_a.sql", "0100_z.sql"]);
  });

  it("delata prefijos repetidos en vez de elegir un orden al azar", () => {
    const { prefijosDuplicados } = ordenarMigraciones(["0007_a.sql", "0007_b.sql"]);
    assert.deepEqual(prefijosDuplicados, ["0007"]);
  });

  it("delata archivos sin prefijo numérico", () => {
    const { sinPrefijo, orden } = ordenarMigraciones(["fix.sql", "0001_a.sql"]);
    assert.deepEqual(sinPrefijo, ["fix.sql"]);
    assert.deepEqual(orden, ["0001_a.sql"]);
  });

  it("el directorio real de migraciones está sano", () => {
    const r = ordenarMigraciones(readdirSync("supabase/migrations"));
    assert.deepEqual(r.prefijosDuplicados, [], "hay prefijos repetidos");
    assert.deepEqual(r.sinPrefijo, [], "hay migraciones sin prefijo");
    assert.ok(
      r.orden.every((f) => !/_rollback\.sql$/i.test(f)),
      "se coló un rollback en la lista de migraciones"
    );
    assert.equal(r.orden[0], "0001_extensions_enums.sql");
  });
});

describe("compararConLedger", () => {
  const c = checksum("select 1;");

  it("sin fila en el ledger, está pendiente", () => {
    assert.deepEqual(compararConLedger(c, undefined), { estado: "pendiente" });
  });

  it("con el mismo checksum, ya está aplicada", () => {
    assert.deepEqual(compararConLedger(c, c), { estado: "aplicada" });
  });

  it("con otro checksum, es divergente y hay que frenar", () => {
    // El archivo cambió después de aplicarse: la base y el repo dicen cosas
    // distintas, y solo se nota cuando alguien recrea la base desde cero.
    const r = compararConLedger(c, checksum("select 2;"));
    assert.equal(r.estado, "divergente");
  });
});

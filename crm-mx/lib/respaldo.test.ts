// La lista de tablas del respaldo no se puede quedar vieja.
//
// El respaldo diario (lib/respaldo.ts) recorre una lista escrita a mano, porque
// PostgREST no sabe listar tablas. El riesgo de esa decisión es exactamente uno:
// alguien crea una tabla, se olvida de sumarla, y el respaldo la deja afuera sin
// decir nada. Esto compara la lista contra las migraciones y falla si no cierran.
//
//   npm test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TABLAS_RESPALDO } from "./respaldo";

const DIR = join(__dirname, "..", "supabase", "migrations");

/** Las tablas de `public` que crean las migraciones, menos las que después se borran. */
function tablasDeLasMigraciones(): Set<string> {
  const vivas = new Set<string>();
  for (const archivo of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(DIR, archivo), "utf8");
    for (const m of sql.matchAll(/^create table (?:if not exists )?([a-z_0-9.]+)/gim)) {
      const nombre = m[1];
      // `ops.*` es el ledger y sus auxiliares: no son datos del CRM y PostgREST
      // ni siquiera los expone.
      if (!nombre.includes(".")) vivas.add(nombre);
    }
    for (const m of sql.matchAll(/^drop table (?:if exists )?([a-z_0-9.]+)/gim)) {
      vivas.delete(m[1]);
    }
  }
  return vivas;
}

describe("TABLAS_RESPALDO", () => {
  it("cubre todas las tablas de public que crean las migraciones", () => {
    const enMigraciones = tablasDeLasMigraciones();
    const enLista = new Set<string>(TABLAS_RESPALDO);
    const faltan = [...enMigraciones].filter((t) => !enLista.has(t)).sort();
    assert.deepEqual(
      faltan,
      [],
      `Estas tablas existen y el respaldo NO las guardaría: ${faltan.join(", ")}. ` +
        "Sumalas a TABLAS_RESPALDO en lib/respaldo.ts."
    );
  });

  it("no nombra tablas que ya no existen", () => {
    const enMigraciones = tablasDeLasMigraciones();
    const sobran = [...TABLAS_RESPALDO].filter((t) => !enMigraciones.has(t)).sort();
    assert.deepEqual(sobran, [], `TABLAS_RESPALDO nombra tablas inexistentes: ${sobran.join(", ")}`);
  });

  it("no repite ninguna", () => {
    assert.equal(new Set(TABLAS_RESPALDO).size, TABLAS_RESPALDO.length);
  });
});

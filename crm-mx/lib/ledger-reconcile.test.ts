// El matcheo de nombres decide si un pago se le cuelga al doctor correcto, si
// se crea una ficha nueva, y si a alguien se lo marca acreditado. Los tres
// errores son caros y ninguno tira excepción: quedan como datos malos.
// Corriendo solo en Vercel, esto es lo único que lo mira.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cleanName, nameMatches, nameTokens } from "./ledger-reconcile";

describe("nameTokens", () => {
  it("saca títulos, acentos y palabras vacías, y ordena", () => {
    assert.deepEqual(nameTokens("Dra. María de la Cruz Pérez"), ["cruz", "maria", "perez"]);
    assert.deepEqual(nameTokens("MARIA CRUZ PEREZ"), ["cruz", "maria", "perez"]);
  });

  it("los títulos que usa la planilla no cuentan como nombre", () => {
    // si "dra" contara como token, dos doctoras cualesquiera compartirían uno
    for (const t of ["Dr.", "Dra.", "Od.", "CD", "Mtra.", "Esp.", "Lic."]) {
      assert.deepEqual(nameTokens(`${t} Juan Kuri Moreno`), ["juan", "kuri", "moreno"], t);
    }
  });

  it("no repite tokens ni deja iniciales sueltas", () => {
    assert.deepEqual(nameTokens("Ana A. Ana Lopez"), ["ana", "lopez"]);
  });
});

describe("nameMatches", () => {
  const t = nameTokens;

  it("3 tokens en común alcanzan", () => {
    assert.ok(nameMatches(t("Juan Kuri Moreno"), t("Dr. Juan Kuri Moreno")));
    assert.ok(nameMatches(t("Juan Carlos Kuri Moreno"), t("Juan Kuri Moreno")));
  });

  it("2 tokens NO alcanzan: ahí se fusionan personas distintas", () => {
    // el caso que motiva la regla: mismo apellido, mismo nombre de pila,
    // segundo apellido distinto = dos personas
    assert.equal(nameMatches(t("Ana Lopez Garcia"), t("Ana Lopez Fernandez")), false);
  });

  it("los nombres de dos palabras tienen que ser idénticos", () => {
    assert.ok(nameMatches(t("Ilse Osuna"), t("Dra. Ilse Osuna")));
    assert.equal(nameMatches(t("Ilse Osuna"), t("Ilse Osuna Ramirez")), false);
  });

  it("un nombre vacío no matchea con nada", () => {
    assert.equal(nameMatches([], t("Juan Kuri Moreno")), false);
    assert.equal(nameMatches(t("Dra."), t("Dra.")), false);
  });
});

describe("cleanName", () => {
  it("la ficha nueva nace sin el título y sin espacios de más", () => {
    assert.equal(cleanName("Dra.  María   Pérez "), "María Pérez");
    assert.equal(cleanName("Dr Juan Kuri"), "Juan Kuri");
    assert.equal(cleanName("María Pérez"), "María Pérez");
  });
});

// ---------------------------------------------------------------------------
// reconciliarLedger contra una base de mentira. Vale la pena el andamio: esta
// función CREA fichas de doctor y vincula plata sin que nadie la mire.

import type { SupabaseClient } from "@supabase/supabase-js";
import { reconciliarLedger } from "./ledger-reconcile";

type FilaDoc = { id: string; nombre: string; is_accredited: boolean };
type FilaPago = { external_key: string; doctor_id: string | null };

/** Mínima parte de la API de supabase-js que usa reconciliarLedger. */
function baseFalsa(doctores: FilaDoc[], pagos: FilaPago[]) {
  const rpc: string[] = [];
  let nuevoId = 0;

  const q = (tabla: string) => {
    const estado: { op?: string; datos?: Record<string, unknown>; keys?: string[]; soloNull?: boolean; id?: string } = {};
    const api: Record<string, unknown> = {};
    const self = () => api;

    api.select = () => api;
    api.order = () => api;
    api.in = (_c: string, v: string[]) => { estado.keys = v; return api; };
    api.eq = (_c: string, v: string) => { estado.id = v; return api; };
    api.is = () => { estado.soloNull = true; return api; };
    api.insert = (d: Record<string, unknown>) => { estado.op = "insert"; estado.datos = d; return api; };
    api.update = (d: Record<string, unknown>) => { estado.op = "update"; estado.datos = d; return api; };

    api.single = () => {
      const d: FilaDoc = {
        id: `nuevo-${++nuevoId}`,
        nombre: String(estado.datos!.nombre),
        is_accredited: true,
      };
      doctores.push(d);
      return Promise.resolve({ data: d, error: null });
    };
    api.range = (from: number, to: number) =>
      Promise.resolve({ data: doctores.slice(from, to + 1), error: null });

    // el await final de las cadenas que no terminan en single()/range()
    api.then = (res: (v: unknown) => unknown) => {
      if (tabla === "payments" && estado.op === "update") {
        const tocadas = pagos.filter(
          (p) => estado.keys!.includes(p.external_key) && p.doctor_id === null
        );
        for (const p of tocadas) p.doctor_id = String(estado.datos!.doctor_id);
        return Promise.resolve(res({ data: tocadas.map((p) => ({ external_key: p.external_key })), error: null }));
      }
      if (tabla === "doctors" && estado.op === "update") {
        const d = doctores.find((x) => x.id === estado.id);
        if (d) d.is_accredited = Boolean(estado.datos!.is_accredited);
        return Promise.resolve(res({ data: null, error: null }));
      }
      if (tabla === "payments") {
        return Promise.resolve(
          res({ data: pagos.filter((p) => p.doctor_id === null).map((p) => ({ external_key: p.external_key })), error: null })
        );
      }
      return Promise.resolve(res({ data: [], error: null }));
    };
    void self;
    return api;
  };

  const db = {
    from: (t: string) => q(t),
    rpc: (fn: string, args: { p_id: string }) => {
      rpc.push(`${fn}:${args.p_id}`);
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { db, doctores, pagos, rpc };
}

const pagoDe = (key: string, prof: string | null) => ({
  external_key: key, doctor_nombre_raw: prof, noloco_id: null, case_external_id: "ME1",
  paciente: null, amount_mxn: 1000, paid_at: "2026-08-15", method: null, notes: null,
});
const mudo = () => {};

describe("reconciliarLedger", () => {
  it("vincula el pago al único doctor que matchea", async () => {
    const f = baseFalsa(
      [{ id: "d1", nombre: "Juan Kuri Moreno", is_accredited: true }],
      [{ external_key: "adminmx:2:1", doctor_id: null }]
    );
    const r = await reconciliarLedger(f.db, [pagoDe("adminmx:2:1", "Dr. Juan Kuri Moreno")], mudo);
    assert.equal(r.linkeados, 1);
    assert.equal(r.creados, 0);
    assert.equal(f.pagos[0].doctor_id, "d1");
    assert.deepEqual(f.rpc, ["recompute_doctor:d1"]);
  });

  it("si el que pagó figuraba como prospecto, lo marca acreditado", async () => {
    const f = baseFalsa(
      [{ id: "d1", nombre: "Juan Kuri Moreno", is_accredited: false }],
      [{ external_key: "adminmx:2:1", doctor_id: null }]
    );
    const r = await reconciliarLedger(f.db, [pagoDe("adminmx:2:1", "Juan Kuri Moreno")], mudo);
    assert.equal(r.acreditados, 1);
    assert.equal(f.doctores[0].is_accredited, true);
  });

  it("si no matchea con nadie, crea la ficha y le cuelga los pagos", async () => {
    const f = baseFalsa(
      [{ id: "d1", nombre: "Otra Persona Distinta", is_accredited: true }],
      [{ external_key: "adminmx:2:1", doctor_id: null }, { external_key: "adminmx:2:2", doctor_id: null }]
    );
    const r = await reconciliarLedger(
      f.db,
      [pagoDe("adminmx:2:1", "Dra. Ilse Osuna Ramirez"), pagoDe("adminmx:2:2", "Dra. Ilse Osuna Ramirez")],
      mudo
    );
    assert.equal(r.creados, 1);
    assert.equal(r.linkeados, 2, "los dos pagos del mismo doctor van juntos");
    assert.equal(f.doctores[1].nombre, "Ilse Osuna Ramirez", "la ficha nace sin el título");
  });

  it("AMBIGUO: si matchea dos fichas no crea una tercera — deja el pago y avisa", async () => {
    // el caso real del 28/8: la misma persona cargada al derecho y al revés
    const f = baseFalsa(
      [
        { id: "d1", nombre: "Guillermo García Garduño", is_accredited: true },
        { id: "d2", nombre: "García Garduño Guillermo", is_accredited: true },
      ],
      [{ external_key: "adminmx:2:1", doctor_id: null }]
    );
    const r = await reconciliarLedger(f.db, [pagoDe("adminmx:2:1", "García Garduño Guillermo")], mudo);
    assert.equal(r.creados, 0, "no crea una tercera ficha");
    assert.equal(r.linkeados, 0, "no adivina cuál de las dos es");
    assert.equal(r.ambiguos.length, 1);
    assert.match(r.ambiguos[0], /Guillermo García Garduño \| García Garduño Guillermo/);
    assert.equal(f.doctores.length, 2, "la base quedó como estaba");
    assert.equal(f.pagos[0].doctor_id, null);
  });

  it("no toca los pagos que ya tienen doctor", async () => {
    const f = baseFalsa(
      [{ id: "d1", nombre: "Juan Kuri Moreno", is_accredited: true }],
      [{ external_key: "adminmx:2:1", doctor_id: "otro" }]
    );
    const r = await reconciliarLedger(f.db, [pagoDe("adminmx:2:1", "Juan Kuri Moreno")], mudo);
    assert.equal(r.huerfanos, 0);
    assert.equal(r.linkeados, 0);
    assert.equal(f.pagos[0].doctor_id, "otro");
  });

  it("el pago cuya fila no dice profesional queda como está, sin inventar ficha", async () => {
    const f = baseFalsa([], [{ external_key: "adminmx:2:1", doctor_id: null }]);
    const r = await reconciliarLedger(f.db, [pagoDe("adminmx:2:1", null)], mudo);
    assert.equal(r.huerfanos, 1);
    assert.equal(r.creados, 0);
    assert.equal(r.linkeados, 0);
  });
});

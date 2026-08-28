// El parser de la planilla decide qué pagos entran al CRM y con qué external_key.
// Si se corre, se duplican pagos o se pierden; si redondea distinto, la cobranza
// del mes no cierra. Corriendo en Vercel, además, nadie mira la salida — así que
// lo que antes verificaba Pancho leyendo la consola tiene que verificarlo esto.
//
// La cabecera es la REAL de "Facturación y Cobranzas" (43 columnas, con sus
// rarezas: dos "ID", "1°PAGO" pegado y "3° PAGO" separado, y un "Saldo 1ª50%"
// metido entre medio que NO es un slot de pago). Las filas son inventadas:
// data/ está gitignoreado porque tiene pagos y teléfonos reales.
//
// Equivalencia con el parser viejo de python (scripts/parse_pagos_planilla.py):
// verificada el 28/8/26 sobre la planilla entera —1.480 filas→ 1.051 pagos y 5
// montos sin fecha, fila por fila idénticos. Ese chequeo no se puede commitear
// (usa los datos reales); este test cubre las reglas que lo hacían pasar.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cellStr,
  facDe,
  grillaDeAppsScript,
  mergeNotes,
  normMethod,
  parsePagos,
  revisarGates,
  toAmount,
  toDate,
  TAB,
  type PagoPlanilla,
} from "./pagos-planilla";

const HEADER = ["ID","ID","TIPO","ETAPA","FECHA DE ENVÍO","PACIENTE","PROFESIONAL","CTA/CTE","ASESORES","FECHA DE D/C","IMPORTE","CATEGORÍA","DESCUENTO CATEGORIA","DESCUENTO EXTRA","MOTIVO","VALOR","FORMA DE PAGO","FECHA FAC","N° FAC","FECHA PAGO","Saldo 1ª50%","1°PAGO","FORMA DE PAGO","FECHA FAC","N° FAC","FECHA PAGO","2°PAGO","FORMA DE PAGO","FECHA FAC","N° FAC","FECHA PAGO","3° PAGO","FORMA DE PAGO","FECHA FAC","N° FAC","FECHA PAGO","4°PAGO","FORMA DE PAGO","FECHA FAC","N° FAC","FECHA PAGO","5°PAGO","SALDO"];

type Celda = string | number | null;

/** Arma una fila de la hoja: los campos del caso + hasta 5 slots de pago. */
function fila(
  caso: { id: string; paciente?: string; profesional?: string },
  slots: { forma?: Celda; nfac?: Celda; fecha?: Celda; monto?: Celda }[]
): Celda[] {
  const r: Celda[] = new Array(HEADER.length).fill(null);
  r[1] = caso.id;
  r[5] = caso.paciente ?? null;
  r[6] = caso.profesional ?? null;
  const FORMA = [16, 22, 27, 32, 37];
  const NFAC = [18, 24, 29, 34, 39];
  const FECHA = [19, 25, 30, 35, 40];
  const MONTO = [21, 26, 31, 36, 41];
  slots.forEach((s, k) => {
    if (s.forma !== undefined) r[FORMA[k]] = s.forma;
    if (s.nfac !== undefined) r[NFAC[k]] = s.nfac;
    if (s.fecha !== undefined) r[FECHA[k]] = s.fecha;
    if (s.monto !== undefined) r[MONTO[k]] = s.monto;
  });
  return r;
}

describe("celdas de la planilla", () => {
  it("cell_str: el número entero no arrastra el .0 que rompería la clave", () => {
    assert.equal(cellStr(26900), "26900");
    assert.equal(cellStr(26900.0), "26900");
    assert.equal(cellStr("  ME3  "), "ME3");
    assert.equal(cellStr(null), "");
  });

  it("to_amount: limpia $ y miles, y descarta lo que no es número", () => {
    assert.equal(toAmount(26900), 26900);
    assert.equal(toAmount("$ 26,900.50"), 26900.5);
    assert.equal(toAmount("-"), null);
    assert.equal(toAmount("—"), null);
    assert.equal(toAmount(""), null);
    assert.equal(toAmount(null), null);
    // Number() aceptaría estos dos; float() de python no, y manda python
    assert.equal(toAmount("0x10"), null);
    assert.equal(toAmount("12abc"), null);
  });

  it("to_date: los 4 formatos, y nada más", () => {
    assert.equal(toDate("2026-08-27"), "2026-08-27");
    assert.equal(toDate("2026-08-27 03:00:00"), "2026-08-27");
    assert.equal(toDate("27/08/2026"), "2026-08-27");
    assert.equal(toDate("9/5/2026"), "2026-05-09");
    assert.equal(toDate("27-08-2026"), "2026-08-27");
    assert.equal(toDate("32/01/2026"), null, "día inexistente no es fecha");
    assert.equal(toDate(26900), null, "un monto no es una fecha");
    assert.equal(toDate("agosto"), null);
  });

  it("norm_method: normaliza las 3 conocidas y respeta el resto", () => {
    assert.equal(normMethod("TR"), "TR");
    assert.equal(normMethod("transferencia"), "TR");
    assert.equal(normMethod("Mercado Pago"), "MP");
    assert.equal(normMethod("Depósito"), "Depósito");
    assert.equal(normMethod("deposito."), "Depósito");
    assert.equal(normMethod("Efectivo"), "Efectivo");
    assert.equal(normMethod(null), null);
  });
});

describe("grilla del Apps Script", () => {
  it("corta el timestamp ISO sin correr el día", () => {
    // 03:00Z es medianoche en México/Argentina: pasarlo por Date daría el 21
    const g = grillaDeAppsScript({ tab: TAB, values: [["2026-04-22T03:00:00.000Z", "x"]] });
    assert.equal(g[0][0], "2026-04-22");
    assert.equal(g[0][1], "x");
  });

  it("no acepta el JSON de otra hoja ni una hoja vacía", () => {
    assert.throws(() => grillaDeAppsScript({ tab: "Otra", values: [[]] }), /no es de la hoja/);
    assert.throws(() => grillaDeAppsScript({ tab: TAB, values: [] }), /vacía/);
  });
});

describe("parsePagos", () => {
  const rows: Celda[][] = [
    HEADER,
    fila({ id: "ME3", paciente: "García A.", profesional: "Dra. Ilse O." }, [
      { forma: "TR", nfac: "A-001", fecha: "2026-03-10", monto: 13450 },
      { forma: "mercadopago", nfac: "-", fecha: "2026-04-10", monto: "$ 13,450.00" },
    ]),
    // monto sin fecha: NO entra, pero se cuenta (es plata que la planilla debe)
    fila({ id: "ME4", paciente: "Pérez B." }, [{ forma: "TR", fecha: null, monto: 5000 }]),
    // slot en 0 y slot en "-": ninguno es un pago
    fila({ id: "ME5" }, [{ monto: 0, fecha: "2026-05-01" }, { monto: "-", fecha: "2026-05-02" }]),
    // fila sin ID: es un separador de la hoja, se saltea entera
    fila({ id: "" }, [{ monto: 999, fecha: "2026-06-01" }]),
  ];
  const { pagos, sinFecha } = parsePagos(rows as never);

  it("toma un pago por slot con monto y fecha, y nada más", () => {
    assert.equal(pagos.length, 2);
    assert.equal(sinFecha, 1);
  });

  it("la external_key es fila-de-la-hoja + slot, que es lo que hace idempotente al sync", () => {
    // fila 2 de la hoja (la primera después del header), slots 1 y 2
    assert.deepEqual(pagos.map((p) => p.external_key), ["adminmx:2:1", "adminmx:2:2"]);
  });

  it("arrastra caso, paciente y profesional, y deja el doctor sin vincular", () => {
    assert.equal(pagos[0].case_external_id, "ME3");
    assert.equal(pagos[0].paciente, "García A.");
    assert.equal(pagos[0].doctor_nombre_raw, "Dra. Ilse O.");
    assert.equal(pagos[0].noloco_id, null, "el vínculo lo hace reconcile-ledger");
  });

  it("normaliza método y factura; el '-' de N° FAC no es una factura", () => {
    assert.equal(pagos[0].method, "TR");
    assert.equal(pagos[0].notes, "fac:A-001");
    assert.equal(pagos[1].method, "MP");
    assert.equal(pagos[1].notes, null);
    assert.equal(pagos[1].amount_mxn, 13450);
  });

  it("si la hoja cambia de estructura, aborta en vez de inventar columnas", () => {
    const roto = [HEADER.filter((c) => c !== "FORMA DE PAGO"), []];
    assert.throws(() => parsePagos(roto as never), /cambió de estructura/);
  });
});

describe("notas", () => {
  it("el sync pisa el fac: y deja intacto lo que escribió el CRM", () => {
    assert.equal(facDe("Doctor sin matchear: X · fac:A-9"), "A-9");
    assert.equal(mergeNotes("Doctor sin matchear: X · fac:A-9", "B-2"), "Doctor sin matchear: X · fac:B-2");
    assert.equal(mergeNotes("Doctor sin matchear: X · fac:A-9", null), "Doctor sin matchear: X");
    assert.equal(mergeNotes(null, "B-2"), "fac:B-2");
  });
});

describe("gates", () => {
  const pago = (key: string, mes: string, monto: number): PagoPlanilla => ({
    external_key: key, doctor_nombre_raw: null, noloco_id: null, case_external_id: "ME1",
    paciente: null, amount_mxn: monto, paid_at: `${mes}-15`, method: null, notes: null,
  });
  const enDb = (p: PagoPlanilla) => ({ id: p.external_key, ...p });
  const mudo = () => {};

  it("deja pasar correcciones chicas", () => {
    const db = [enDb(pago("k1", "2026-07", 100)), enDb(pago("k2", "2026-07", 200))];
    const fresco = [pago("k1", "2026-07", 105), pago("k2", "2026-07", 200)];
    assert.doesNotThrow(() => revisarGates(db, fresco, "2026-08-28", mudo));
  });

  it("aborta si se corrieron las filas (>20 pagos derivados)", () => {
    const db = Array.from({ length: 25 }, (_, i) => enDb(pago(`k${i}`, "2026-08", 100)));
    assert.throws(() => revisarGates(db, [], "2026-08-28", mudo), /corrimiento de filas/);
  });

  it("aborta si un mes ya cerrado se achica", () => {
    const db = [enDb(pago("k1", "2026-07", 100)), enDb(pago("k2", "2026-07", 200))];
    const fresco = [pago("k1", "2026-07", 100), pago("k2", "2026-07", 50)];
    assert.throws(() => revisarGates(db, fresco, "2026-08-28", mudo), /mes cerrado 2026-07 se achica/);
  });

  it("el mes en curso SÍ puede moverse: todavía se está cargando", () => {
    const db = [enDb(pago("k1", "2026-08", 500))];
    const fresco = [pago("k1", "2026-08", 100)];
    assert.doesNotThrow(() => revisarGates(db, fresco, "2026-08-28", mudo));
  });
});

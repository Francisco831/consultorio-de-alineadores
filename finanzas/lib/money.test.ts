import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoneyInput, sumByCurrency, formatMoney } from "./money";

test("parseMoneyInput: coma decimal es-AR", () => {
  assert.equal(parseMoneyInput("1.711.272,40"), 1711272.4);
  assert.equal(parseMoneyInput("1234,5"), 1234.5);
  assert.equal(parseMoneyInput("$ 152.430"), 152430);
});

test("parseMoneyInput: punto decimal", () => {
  assert.equal(parseMoneyInput("1,711,272.40"), 1711272.4);
  assert.equal(parseMoneyInput("30000"), 30000);
});

test("parseMoneyInput: basura", () => {
  assert.equal(parseMoneyInput(""), null);
  assert.equal(parseMoneyInput("abc"), null);
});

test("sumByCurrency: buckets por moneda, jamás mezcla", () => {
  const r = sumByCurrency([
    { amount: 100.1, currency: "ARS" },
    { amount: 200.2, currency: "ARS" },
    { amount: 50, currency: "USD" },
  ]);
  assert.equal(r.ARS, 300.3);
  assert.equal(r.USD, 50);
  assert.equal(Object.keys(r).length, 2);
});

test("formatMoney: null → em dash", () => {
  assert.equal(formatMoney(null, "ARS", "es-AR"), "—");
});

test("formatMoney: USD en es-AR usa US$", () => {
  const out = formatMoney(1234, "USD", "es-AR");
  assert.ok(out.includes("US$"), out);
});

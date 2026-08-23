import { serviceClient, fetchAllRows } from "./lib/service-client";
async function main() {
  const db = await serviceClient({ accion: "cobros sin comprobante jun-jul", auto: true });
  const { data: cia } = await db.from("companies").select("id").eq("slug", "ar").single();
  const { data: ctas } = await db.from("accounts").select("id, name, separate_books").eq("company_id", cia!.id);
  const sep = new Set((ctas ?? []).filter((c) => c.separate_books).map((c) => c.id));
  const nombre = new Map((ctas ?? []).map((c) => [c.id, c.name]));

  const movs = await fetchAllRows<{ id: string; occurred_on: string; amount: string; currency: string;
    description: string | null; account_id: string;
    counterparty: { display_name?: string } | { display_name?: string }[] | null }>(
    db, "movements", "id, occurred_on, amount, currency, description, account_id, counterparty:counterparties(display_name)",
    (q) => q.eq("company_id", cia!.id).eq("kind", "income").neq("status", "void")
      .gte("occurred_on", "2026-06-01").lte("occurred_on", "2026-07-31"));
  const docs = await fetchAllRows<{ entity_id: string }>(db, "documents", "entity_id",
    (q) => q.eq("company_id", cia!.id).eq("entity_type", "movement"));
  const conDoc = new Set(docs.map((d) => d.entity_id));

  const propios = movs.filter((m) => !sep.has(m.account_id));
  const sin = propios.filter((m) => !conDoc.has(m.id));
  console.log(`cobros jun-jul (sin Coni): ${propios.length} | con comprobante: ${propios.length - sin.length} | SIN: ${sin.length}`);
  const porCuenta = new Map<string, number>();
  for (const m of sin) porCuenta.set(nombre.get(m.account_id) ?? "?", (porCuenta.get(nombre.get(m.account_id) ?? "?") ?? 0) + 1);
  console.log("sin comprobante por cuenta:", [...porCuenta].map(([k, v]) => `${k}: ${v}`).join(" | "));
  console.log("\n--- detalle ---");
  for (const m of sin.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on))) {
    const n = (Array.isArray(m.counterparty) ? m.counterparty[0]?.display_name : m.counterparty?.display_name) || "—";
    console.log(`${m.occurred_on}\t${m.currency}\t${Number(m.amount)}\t${n}\t${nombre.get(m.account_id)}\t${m.description ?? ""}`);
  }
}
main();

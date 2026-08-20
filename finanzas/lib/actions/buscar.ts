"use server";

import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import { parseMoneyInput } from "@/lib/money";

export type Resultado = {
  tipo: "contraparte" | "movimiento" | "producto" | "deuda";
  titulo: string;
  detalle: string;
  href: string;
};

/**
 * Buscador global. Busca en contrapartes, conceptos, productos y deudas — y si
 * lo que escribís parece un número, también por monto exacto: buscar "152430"
 * cuando ves ese importe en el banco es el caso más frecuente de todos.
 * Nunca devuelve nada de la otra empresa.
 */
export async function buscarGlobal(empresa: "mx" | "ar", q: string): Promise<Resultado[]> {
  const termino = q.trim();
  if (termino.length < 2) return [];
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const like = `%${termino}%`;
  const monto = parseMoneyInput(termino);
  const out: Resultado[] = [];

  const [contrapartes, movimientos, productos, deudas, porMonto] = await Promise.all([
    supabase.from("counterparties").select("id, display_name, kind")
      .eq("company_id", ctx.companyId).ilike("display_name", like).limit(5),
    supabase.from("movements")
      .select("id, occurred_on, amount, currency, description, kind")
      .eq("company_id", ctx.companyId).neq("status", "void")
      .ilike("description", like).order("occurred_on", { ascending: false }).limit(5),
    supabase.from("products").select("id, name, category")
      .eq("company_id", ctx.companyId).ilike("name", like).limit(4),
    supabase.from("v_payables_buckets").select("id, concept, currency, balance, due_on")
      .eq("company_id", ctx.companyId).ilike("concept", like).limit(4),
    monto && monto > 0
      ? supabase.from("movements")
          .select("id, occurred_on, amount, currency, description, kind")
          .eq("company_id", ctx.companyId).neq("status", "void")
          .eq("amount", monto).order("occurred_on", { ascending: false }).limit(5)
      : Promise.resolve({ data: [] }),
  ]);

  const KIND: Record<string, string> = {
    patient: "Paciente", doctor_customer: "Doctor", supplier: "Proveedor",
    professional: "Profesional", employee: "Empleada", tax_agency: "Organismo", other: "Contacto",
  };
  for (const c of contrapartes.data ?? []) {
    out.push({
      tipo: "contraparte",
      titulo: c.display_name,
      detalle: KIND[c.kind] ?? c.kind,
      href: c.kind === "supplier" || c.kind === "professional"
        ? `/${empresa}/proveedores/${c.id}`
        : `/${empresa}/movimientos?q=${encodeURIComponent(c.display_name)}`,
    });
  }
  for (const m of [...(porMonto.data ?? []), ...(movimientos.data ?? [])]) {
    if (out.some((r) => r.href.endsWith(m.id))) continue;
    out.push({
      tipo: "movimiento",
      titulo: m.description || (m.kind === "income" ? "Ingreso" : "Egreso"),
      detalle: `${m.occurred_on} · ${m.currency} ${Number(m.amount).toLocaleString("es-AR")}`,
      href: `/${empresa}/movimientos?q=${encodeURIComponent(m.description ?? "")}`,
    });
  }
  for (const p of productos.data ?? []) {
    out.push({
      tipo: "producto", titulo: p.name, detalle: p.category ?? "Producto",
      href: `/${empresa}/compras?t=precios`,
    });
  }
  for (const d of deudas.data ?? []) {
    out.push({
      tipo: "deuda", titulo: d.concept,
      detalle: `Vence ${d.due_on} · ${d.currency} ${Number(d.balance).toLocaleString("es-AR")}`,
      href: `/${empresa}/pagar`,
    });
  }
  return out.slice(0, 14);
}

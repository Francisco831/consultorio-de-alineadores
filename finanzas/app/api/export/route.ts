// Exportación a CSV. Devuelve el archivo con la misma RLS que la app: si el
// usuario no es miembro de la empresa, no hay datos que exportar.
//
// CSV y no xlsx a propósito: abre en Excel, en Sheets y en cualquier cosa, y no
// arrastra una librería de 3 MB al servidor. El BOM inicial es lo que hace que
// Excel muestre bien los acentos.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

export const dynamic = "force-dynamic";

type Fila = Record<string, unknown>;

function aCsv(filas: Fila[], columnas: Array<{ key: string; label: string }>): string {
  const escapar = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cabecera = columnas.map((c) => escapar(c.label)).join(";");
  const cuerpo = filas.map((f) => columnas.map((c) => escapar(f[c.key])).join(";"));
  return "﻿" + [cabecera, ...cuerpo].join("\r\n");
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const empresa = url.searchParams.get("empresa") ?? "";
  const reporte = url.searchParams.get("r") ?? "movimientos";
  if (empresa !== "mx" && empresa !== "ar") {
    return NextResponse.json({ error: "empresa inválida" }, { status: 400 });
  }
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  let filas: Fila[] = [];
  let columnas: Array<{ key: string; label: string }> = [];

  if (reporte === "movimientos") {
    const rows = await fetchAllRows<Fila>((from, to) =>
      supabase.from("movements")
        .select("occurred_on, kind, status, amount, currency, description, source, counterparties(display_name), categories(name), accounts!movements_account_company_fk(name)")
        .eq("company_id", ctx.companyId).neq("status", "void")
        .order("occurred_on", { ascending: false }).range(from, to)
    );
    filas = rows.map((r) => ({
      fecha: r.occurred_on,
      tipo: r.kind === "income" ? "Ingreso" : r.kind === "expense" ? "Egreso" : "Transferencia",
      concepto: r.description ?? "",
      contraparte: (r.counterparties as { display_name?: string } | null)?.display_name ?? "",
      categoria: (r.categories as { name?: string } | null)?.name ?? "",
      cuenta: (r.accounts as { name?: string } | null)?.name ?? "",
      moneda: r.currency,
      monto: r.amount,
      estado: r.status === "confirmed" ? "Confirmado" : "Pendiente",
      origen: r.source,
    }));
    columnas = [
      { key: "fecha", label: "Fecha" }, { key: "tipo", label: "Tipo" },
      { key: "concepto", label: "Concepto" }, { key: "contraparte", label: "Contraparte" },
      { key: "categoria", label: "Categoría" }, { key: "cuenta", label: "Cuenta" },
      { key: "moneda", label: "Moneda" }, { key: "monto", label: "Monto" },
      { key: "estado", label: "Estado" }, { key: "origen", label: "Origen" },
    ];
  } else if (reporte === "proveedores") {
    const { data } = await supabase.from("v_supplier_spend")
      .select("supplier_name, currency, month, total, movimientos")
      .eq("company_id", ctx.companyId).order("month");
    filas = (data ?? []).map((r) => ({
      mes: String(r.month).slice(0, 7), proveedor: r.supplier_name,
      moneda: r.currency, total: r.total, movimientos: r.movimientos,
    }));
    columnas = [
      { key: "mes", label: "Mes" }, { key: "proveedor", label: "Proveedor" },
      { key: "moneda", label: "Moneda" }, { key: "total", label: "Total" },
      { key: "movimientos", label: "Movimientos" },
    ];
  } else if (reporte === "liquidaciones") {
    const { data } = await supabase.from("professional_settlements")
      .select("period, status, pct, totals, professional:counterparties(display_name)")
      .eq("company_id", ctx.companyId).order("period");
    filas = (data ?? []).map((r) => {
      const t = (r.totals as { ARS?: Record<string, number> })?.ARS ?? {};
      return {
        periodo: r.period,
        profesional: (r.professional as { display_name?: string } | null)?.display_name ?? "",
        cobrado: t.collected ?? 0, costo_ks: t.ks_cost ?? 0, base: t.base ?? 0,
        pct: r.pct, liquidacion: t.due ?? 0, retiros: t.withdrawn ?? 0,
        saldo: t.balance ?? 0, estado: r.status,
      };
    });
    columnas = [
      { key: "periodo", label: "Período" }, { key: "profesional", label: "Profesional" },
      { key: "cobrado", label: "Cobrado" }, { key: "costo_ks", label: "Costo KS" },
      { key: "base", label: "Base" }, { key: "pct", label: "%" },
      { key: "liquidacion", label: "Liquidación" }, { key: "retiros", label: "Retiros" },
      { key: "saldo", label: "Saldo" }, { key: "estado", label: "Estado" },
    ];
  } else if (reporte === "precios") {
    const { data } = await supabase.from("v_product_prices").select("*")
      .eq("company_id", ctx.companyId).order("gasto_total", { ascending: false });
    filas = (data ?? []).map((r) => ({
      producto: r.product_name, moneda: r.currency, compras: r.compras,
      ultimo: r.precio_ultimo, promedio: r.precio_promedio,
      minimo: r.precio_min, maximo: r.precio_max,
      variacion: r.variacion_pct, gasto_total: r.gasto_total,
    }));
    columnas = [
      { key: "producto", label: "Producto" }, { key: "moneda", label: "Moneda" },
      { key: "compras", label: "Compras" }, { key: "ultimo", label: "Último precio" },
      { key: "promedio", label: "Promedio" }, { key: "minimo", label: "Mínimo" },
      { key: "maximo", label: "Máximo" }, { key: "variacion", label: "Variación %" },
      { key: "gasto_total", label: "Gasto total" },
    ];
  } else {
    return NextResponse.json({ error: "reporte desconocido" }, { status: 400 });
  }

  const csv = aCsv(filas, columnas);
  const nombre = `${reporte}-${empresa}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nombre}"`,
      "Cache-Control": "no-store",
    },
  });
}

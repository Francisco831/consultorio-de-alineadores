"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireEmpresa } from "@/lib/empresa-context";
import { parseMacroSheet } from "@/lib/import/parse-macro";
import { KeyBuilder, sha256Hex } from "@/lib/import/keys";
import { matchear, type LineaExtracto, type MovimientoCandidato } from "@/lib/conciliacion/matcher";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

// ---------------------------------------------------------------------------
// Paso 1: analizar el archivo subido → matriz de celdas + (si es macro) líneas
// ---------------------------------------------------------------------------

export type LineaPreview = {
  fecha: string;
  amount: number;
  descripcion: string;
  contraparte: string | null;
  raw: Record<string, unknown>;
};

export async function analizarArchivo(formData: FormData): Promise<
  | { error: string }
  | { fileName: string; fileSha256: string; headers: string[]; rows: (string | null)[][]; lineasMacro: LineaPreview[] | null }
> {
  const file = formData.get("file") as File | null;
  const fuente = String(formData.get("fuente") ?? "generico");
  if (!file) return { error: "Falta el archivo" };
  if (file.size > 8 * 1024 * 1024) return { error: "Archivo muy grande (máx 8 MB)" };

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileSha256 = sha256Hex(buffer.toString("base64"));

  let matrix: (string | null)[][] = [];
  if (/\.(xlsx|xlsm)$/i.test(file.name)) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return { error: "El xlsx no tiene hojas" };
    ws.eachRow({ includeEmpty: true }, (row) => {
      const values: (string | null)[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c);
        const v = cell.value;
        if (v == null) values.push(null);
        else if (v instanceof Date) values.push(v.toISOString().slice(0, 10));
        else if (typeof v === "object" && "result" in v) values.push(String((v as { result: unknown }).result ?? ""));
        else if (typeof v === "object" && "richText" in v)
          values.push((v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join(""));
        else values.push(String(v));
      }
      matrix.push(values);
    });
  } else if (/\.csv$/i.test(file.name)) {
    const Papa = (await import("papaparse")).default;
    const parsed = Papa.parse<string[]>(buffer.toString("utf8"), { skipEmptyLines: true });
    matrix = parsed.data.map((r) => r.map((c) => (c === "" ? null : c)));
  } else {
    return { error: "Formato no soportado: subí .xlsx o .csv" };
  }

  if (matrix.length === 0) return { error: "El archivo está vacío" };
  matrix = matrix.slice(0, 2000); // techo sano

  let lineasMacro: LineaPreview[] | null = null;
  if (fuente === "macro") {
    const r = parseMacroSheet(matrix);
    lineasMacro = r.lines.map((l) => ({
      fecha: l.fecha,
      amount: l.amount,
      descripcion: l.descripcion,
      contraparte: l.contraparte,
      raw: l.raw,
    }));
  }

  return {
    fileName: file.name,
    fileSha256,
    headers: (matrix[0] ?? []).map((c) => c ?? ""),
    rows: matrix,
    lineasMacro,
  };
}

// ---------------------------------------------------------------------------
// Paso 2: importar líneas ya tipadas → import_batch + statement_lines
// ---------------------------------------------------------------------------

const ImportarSchema = z.object({
  empresa: z.enum(["mx", "ar"]),
  accountId: z.string().uuid(),
  source: z.enum(["macro", "bbva", "mp_ar", "mp_mx", "csv", "xlsx"]),
  fileName: z.string().max(200),
  fileSha256: z.string().max(64),
  lineas: z
    .array(
      z.object({
        fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        amount: z.number(),
        descripcion: z.string().max(500),
        contraparte: z.string().max(200).nullable(),
        raw: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .min(1)
    .max(2000),
});

export async function importarLineas(input: z.infer<typeof ImportarSchema>) {
  const parsed = ImportarSchema.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos" };
  const d = parsed.data;
  const ctx = await requireEmpresa(d.empresa);
  const supabase = await createClient();

  const { data: account } = await supabase
    .from("accounts")
    .select("id, currency")
    .eq("id", d.accountId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  if (!account) return { error: "Cuenta inexistente" };

  // batch idempotente por hash del archivo
  const { data: prevBatch } = await supabase
    .from("import_batches")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("account_id", account.id)
    .eq("file_sha256", d.fileSha256)
    .maybeSingle();

  let batchId = prevBatch?.id as string | undefined;
  if (!batchId) {
    const fechas = d.lineas.map((l) => l.fecha).sort();
    const { data: batch, error } = await supabase
      .from("import_batches")
      .insert({
        company_id: ctx.companyId,
        account_id: account.id,
        source: d.source,
        filename: d.fileName,
        file_sha256: d.fileSha256,
        period_from: fechas[0],
        period_to: fechas[fechas.length - 1],
        status: "done",
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (error) return { error: `No se pudo crear el batch: ${error.message}` };
    batchId = batch.id;
  }

  const keys = new KeyBuilder();
  const rows = d.lineas.map((l, i) => ({
    company_id: ctx.companyId,
    batch_id: batchId,
    account_id: account.id,
    line_no: i + 1,
    posted_on: l.fecha,
    description_raw: l.descripcion,
    counterparty_raw: l.contraparte,
    amount: l.amount,
    currency: account.currency,
    external_key: keys.build(d.source, l.fecha, l.amount, l.descripcion, l.contraparte),
    match_status: "pending",
    raw: l.raw,
  }));

  const { count: antes } = await supabase
    .from("statement_lines")
    .select("id", { count: "exact", head: true })
    .eq("company_id", ctx.companyId)
    .eq("account_id", account.id);

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("statement_lines")
      .upsert(rows.slice(i, i + 500), {
        onConflict: "company_id,account_id,external_key",
        ignoreDuplicates: true,
      });
    if (error) return { error: `Error insertando líneas: ${error.message}` };
  }

  const { count: despues } = await supabase
    .from("statement_lines")
    .select("id", { count: "exact", head: true })
    .eq("company_id", ctx.companyId)
    .eq("account_id", account.id);

  const insertadas = (despues ?? 0) - (antes ?? 0);
  revalidatePath(`/${d.empresa}/movimientos/conciliar`);
  return { ok: true, insertadas, duplicadas: rows.length - insertadas };
}

// ---------------------------------------------------------------------------
// Conciliación
// ---------------------------------------------------------------------------

export async function sugerirMatches(empresa: "mx" | "ar") {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  // PostgREST corta todo SELECT en 1.000 filas SIN error: acá se cuenta y
  // cruza en JS, así que SIEMPRE fetchAllRows (lección documentada del CRM).
  const lineas = await fetchAllRows<{
    id: string; posted_on: string; amount: number; currency: string;
    counterparty_raw: string | null; description_raw: string; external_key: string;
  }>((from, to) =>
    supabase
      .from("statement_lines")
      .select("id, posted_on, amount, currency, counterparty_raw, description_raw, external_key")
      .eq("company_id", ctx.companyId)
      .in("match_status", ["pending", "unidentified"])
      .order("id")
      .range(from, to)
  );
  if (!lineas.length) return { ok: true, sugeridas: 0, sinMatch: 0 };

  // candidatos: movimientos no anulados y todavía sin conciliar
  const reconciliados = await fetchAllRows<{ movement_id: string }>((from, to) =>
    supabase
      .from("reconciliations")
      .select("movement_id")
      .eq("company_id", ctx.companyId)
      .order("id")
      .range(from, to)
  );
  const yaConciliados = new Set(reconciliados.map((r) => r.movement_id));

  // supabase-js tipa el embed to-one como array: normalizamos al leer
  const movs = await fetchAllRows<{
    id: string; occurred_on: string; amount: number; currency: string; kind: string;
    description: string | null; external_key: string | null;
    counterparty: { display_name?: string } | { display_name?: string }[] | null;
  }>((from, to) =>
    supabase
      .from("movements")
      .select("id, occurred_on, amount, currency, kind, description, external_key, counterparty:counterparties(display_name)")
      .eq("company_id", ctx.companyId)
      .neq("status", "void")
      .in("kind", ["income", "expense"])
      .order("id")
      .range(from, to)
  );

  let sugeridas = 0;
  let sinMatch = 0;
  // agrupar por moneda y signo: crédito (amount>0) ↔ income · débito ↔ expense
  for (const currency of new Set(lineas.map((l) => l.currency))) {
    for (const signo of [1, -1]) {
      const kind = signo > 0 ? "income" : "expense";
      const ls: LineaExtracto[] = lineas
        .filter((l) => l.currency === currency && Math.sign(Number(l.amount)) === signo)
        .map((l) => ({
          id: l.id,
          fecha: l.posted_on,
          monto: Math.abs(Number(l.amount)),
          nombre: l.counterparty_raw || l.description_raw || "",
          externalKey: l.external_key,
        }));
      if (!ls.length) continue;
      const ms: MovimientoCandidato[] = movs
        .filter((m) => m.currency === currency && m.kind === kind && !yaConciliados.has(m.id))
        .map((m) => ({
          id: m.id,
          fecha: m.occurred_on,
          monto: Number(m.amount),
          nombre:
            (Array.isArray(m.counterparty)
              ? m.counterparty[0]?.display_name
              : m.counterparty?.display_name) ||
            m.description ||
            "",
          externalKey: m.external_key,
        }));

      const r = matchear(ls, ms);
      for (const s of r.sugerencias) {
        await supabase.from("match_suggestions").delete().eq("statement_line_id", s.lineaId);
        const { error } = await supabase.from("match_suggestions").insert(
          s.movementIds.map((mid) => ({
            company_id: ctx.companyId,
            statement_line_id: s.lineaId,
            movement_id: mid,
            score: s.score,
            method: s.method,
          }))
        );
        if (!error) {
          await supabase
            .from("statement_lines")
            .update({ match_status: "suggested", match_score: s.score, match_method: s.method })
            .eq("id", s.lineaId);
          sugeridas++;
        }
      }
      for (const lid of r.lineasSinMatch) {
        await supabase.from("statement_lines").update({ match_status: "unidentified" }).eq("id", lid);
        sinMatch++;
      }
    }
  }

  revalidatePath(`/${empresa}/movimientos/conciliar`);
  return { ok: true, sugeridas, sinMatch };
}

export async function confirmarSugerencia(empresa: "mx" | "ar", lineaId: string) {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: linea } = await supabase
    .from("statement_lines")
    .select("id, amount")
    .eq("id", lineaId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  if (!linea) return { error: "Línea inexistente" };

  const { data: sugerencias } = await supabase
    .from("match_suggestions")
    .select("movement_id, score")
    .eq("statement_line_id", lineaId);
  if (!sugerencias?.length) return { error: "La línea no tiene sugerencia" };

  // Un movimiento SÍ puede cerrar contra varias líneas (el paciente paga en dos
  // transferencias y la caja lo anota una vez), pero lo conciliado nunca puede
  // superar su monto: eso sería contar la misma plata dos veces.
  const { data: yaAplicado } = await supabase
    .from("reconciliations")
    .select("movement_id, amount, movement:movements(amount)")
    .in("movement_id", sugerencias.map((s) => s.movement_id));
  for (const s of sugerencias) {
    const previas = (yaAplicado ?? []).filter((r) => r.movement_id === s.movement_id);
    if (!previas.length) continue;
    const montoMovimiento = Number(
      (previas[0].movement as { amount?: number } | null)?.amount ?? 0
    );
    const suma = previas.reduce((a, r) => a + Math.abs(Number(r.amount)), 0) + Math.abs(Number(linea.amount));
    if (suma > montoMovimiento + 0.01) {
      return {
        error: "Ese movimiento ya está conciliado por su monto completo: conciliarlo de nuevo contaría la plata dos veces.",
      };
    }
  }

  const { error } = await supabase.from("reconciliations").insert(
    sugerencias.map((s) => ({
      company_id: ctx.companyId,
      statement_line_id: lineaId,
      movement_id: s.movement_id,
      amount: linea.amount,
      matched_by: "user",
      confidence: s.score,
      created_by: ctx.userId,
    }))
  );
  if (error) return { error: error.message };

  await supabase
    .from("statement_lines")
    .update({ match_status: "matched", matched_movement_id: sugerencias[0].movement_id })
    .eq("id", lineaId);
  await supabase.from("match_suggestions").delete().eq("statement_line_id", lineaId);

  revalidatePath(`/${empresa}/movimientos/conciliar`);
  return { ok: true };
}

export async function crearDesdeLinea(
  empresa: "mx" | "ar",
  lineaId: string,
  categoryId: string | null
) {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();

  const { data: linea } = await supabase
    .from("statement_lines")
    .select("id, account_id, posted_on, amount, currency, description_raw, counterparty_raw, external_key")
    .eq("id", lineaId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  if (!linea) return { error: "Línea inexistente" };

  const monto = Number(linea.amount);
  const { data: mov, error } = await supabase
    .from("movements")
    .insert({
      company_id: ctx.companyId,
      account_id: linea.account_id,
      currency: linea.currency,
      kind: monto >= 0 ? "income" : "expense",
      status: "confirmed",
      occurred_on: linea.posted_on,
      amount: Math.abs(monto),
      category_id: categoryId,
      description: linea.description_raw || linea.counterparty_raw || "Desde extracto",
      source: "import",
      external_key: `sline:${linea.external_key}`,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  await supabase.from("reconciliations").insert({
    company_id: ctx.companyId,
    statement_line_id: lineaId,
    movement_id: mov.id,
    amount: linea.amount,
    matched_by: "user",
    created_by: ctx.userId,
  });
  await supabase
    .from("statement_lines")
    .update({ match_status: "matched", matched_movement_id: mov.id })
    .eq("id", lineaId);

  revalidatePath(`/${empresa}/movimientos/conciliar`);
  revalidatePath(`/${empresa}/movimientos`);
  return { ok: true };
}

export async function marcarLinea(
  empresa: "mx" | "ar",
  lineaId: string,
  estado: "duplicate" | "ignored" | "pending"
) {
  const ctx = await requireEmpresa(empresa);
  const supabase = await createClient();
  const { error } = await supabase
    .from("statement_lines")
    .update({ match_status: estado })
    .eq("id", lineaId)
    .eq("company_id", ctx.companyId);
  if (error) return { error: error.message };
  revalidatePath(`/${empresa}/movimientos/conciliar`);
  return { ok: true };
}

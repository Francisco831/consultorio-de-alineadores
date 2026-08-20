"use client";

// Wizard de 3 pasos: archivo → mapeo (si es genérico) → preview e importar.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CampoSelect } from "@/components/ui/campo-select";
import { analizarArchivo, importarLineas, sugerirMatches, type LineaPreview } from "@/lib/actions/importar";
import { parseAmount, parseDateDDMM } from "@/lib/import/normalize";
import type { EmpresaSlug } from "@/lib/empresas";

type Cuenta = { id: string; name: string; currency: string };
type Analisis = {
  fileName: string;
  fileSha256: string;
  headers: string[];
  rows: (string | null)[][];
  lineasMacro: LineaPreview[] | null;
};

const DESTINOS = ["ignorar", "fecha", "monto", "credito", "debito", "descripcion", "contraparte"] as const;
type Destino = (typeof DESTINOS)[number];

export function ImportWizard({ empresa, cuentas }: { empresa: EmpresaSlug; cuentas: Cuenta[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [cuentaId, setCuentaId] = useState(cuentas[0]?.id ?? "");
  const [fuente, setFuente] = useState<"macro" | "generico">("generico");
  const [analisis, setAnalisis] = useState<Analisis | null>(null);
  const [mapa, setMapa] = useState<Record<number, Destino>>({});
  const [headerRow, setHeaderRow] = useState(true);

  function analizar(form: HTMLFormElement) {
    const fd = new FormData(form);
    fd.set("fuente", fuente);
    startTransition(async () => {
      const res = await analizarArchivo(fd);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setAnalisis(res);
      // auto-detección por nombre de header
      const auto: Record<number, Destino> = {};
      res.headers.forEach((h, i) => {
        const n = h.toLowerCase();
        if (/fecha/.test(n)) auto[i] = "fecha";
        else if (/cr[eé]dito/.test(n)) auto[i] = "credito";
        else if (/d[eé]bito/.test(n)) auto[i] = "debito";
        else if (/importe|monto/.test(n)) auto[i] = "monto";
        else if (/detalle|descrip|concepto/.test(n)) auto[i] = "descripcion";
        else if (/paciente|nombre|pagador|contraparte/.test(n)) auto[i] = "contraparte";
      });
      setMapa(auto);
    });
  }

  function lineasGenericas(): LineaPreview[] {
    if (!analisis) return [];
    const cols = Object.entries(mapa).reduce<Record<Destino, number[]>>((acc, [i, d]) => {
      (acc[d] ??= []).push(Number(i));
      return acc;
    }, {} as Record<Destino, number[]>);
    const out: LineaPreview[] = [];
    const desde = headerRow ? 1 : 0;
    for (let r = desde; r < analisis.rows.length; r++) {
      const row = analisis.rows[r];
      if (!row || row.every((c) => !c)) continue;
      const fecha = parseDateDDMM(row[cols.fecha?.[0] ?? -1] ?? null);
      if (!fecha) continue;
      let amount: number | null = null;
      const cr = parseAmount(row[cols.credito?.[0] ?? -1] ?? null);
      const db = parseAmount(row[cols.debito?.[0] ?? -1] ?? null);
      if (cr != null && cr !== 0) amount = Math.abs(cr);
      else if (db != null && db !== 0) amount = -Math.abs(db);
      else amount = parseAmount(row[cols.monto?.[0] ?? -1] ?? null);
      if (amount == null || amount === 0) continue;
      const raw: Record<string, unknown> = {};
      analisis.headers.forEach((h, i) => { if (h) raw[h] = row[i]; });
      out.push({
        fecha,
        amount,
        descripcion: String(row[cols.descripcion?.[0] ?? -1] ?? "").trim(),
        contraparte: String(row[cols.contraparte?.[0] ?? -1] ?? "").trim() || null,
        raw,
      });
    }
    return out;
  }

  const lineas = analisis ? (fuente === "macro" ? analisis.lineasMacro ?? [] : lineasGenericas()) : [];

  function importar() {
    if (!analisis || !lineas.length) return;
    startTransition(async () => {
      const res = await importarLineas({
        empresa,
        accountId: cuentaId,
        source: fuente === "macro" ? "macro" : "csv",
        fileName: analisis.fileName,
        fileSha256: analisis.fileSha256,
        lineas: lineas.map((l) => ({ ...l, raw: l.raw as Record<string, unknown> })),
      });
      if ("error" in res && res.error) {
        toast.error(res.error);
        return;
      }
      const r = res as { insertadas: number; duplicadas: number };
      toast.success(`${r.insertadas} líneas importadas · ${r.duplicadas} ya existían`);
      await sugerirMatches(empresa);
      router.push(`/${empresa}/movimientos/conciliar`);
    });
  }

  return (
    <div className="space-y-4">
      <form
        className="space-y-3 rounded-xl border bg-card p-5 shadow-sm"
        onSubmit={(e) => { e.preventDefault(); analizar(e.currentTarget); }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Cuenta del extracto</Label>
            <CampoSelect value={cuentaId} onValueChange={setCuentaId}
              opciones={cuentas.map((c) => ({ value: c.id, label: `${c.name} · ${c.currency}` }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Formato</Label>
            <CampoSelect value={fuente} onValueChange={(v) => setFuente(v as "macro" | "generico")}
              opciones={[
                { value: "generico", label: "CSV / Excel genérico (mapear columnas)" },
                { value: "macro", label: "Extracto Banco Macro (xlsx)" },
              ]} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="file">Archivo (.xlsx / .csv)</Label>
          <Input id="file" name="file" type="file" accept=".xlsx,.csv" required />
        </div>
        <Button type="submit" disabled={pending || !cuentaId}>
          {pending ? "Analizando…" : "Analizar archivo"}
        </Button>
      </form>

      {analisis && fuente === "generico" ? (
        <div className="space-y-3 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Mapeo de columnas</h2>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox" checked={headerRow}
                onChange={(e) => setHeaderRow(e.target.checked)}
              />
              La primera fila es encabezado
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {analisis.headers.map((h, i) => (
              <div key={i} className="space-y-1">
                <div className="truncate text-xs text-muted-foreground">
                  {h || `Columna ${i + 1}`}
                </div>
                <CampoSelect
                  value={mapa[i] ?? "ignorar"} className="h-8"
                  onValueChange={(v) => setMapa((m) => ({ ...m, [i]: v as Destino }))}
                  opciones={DESTINOS.map((d) => ({ value: d, label: d }))} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {analisis ? (
        <div className="space-y-3 rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold">
            Preview · {lineas.length} líneas legibles de {analisis.rows.length} filas
          </h2>
          <div className="max-h-64 overflow-auto rounded border">
            <table className="w-full text-xs">
              <tbody>
                {lineas.slice(0, 15).map((l, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="fig px-2 py-1 text-muted-foreground">{l.fecha}</td>
                    <td className="max-w-[200px] truncate px-2 py-1">{l.contraparte ?? l.descripcion}</td>
                    <td className={`fig px-2 py-1 text-right font-medium ${l.amount < 0 ? "text-red-500" : ""}`}>
                      {l.amount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button onClick={importar} disabled={pending || !lineas.length} className="w-full">
            {pending ? "Importando…" : `Importar ${lineas.length} líneas y conciliar`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

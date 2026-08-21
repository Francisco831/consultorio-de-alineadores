// Trae la caja del consultorio (Apps Script gas-caja-ar.gs) y regenera los
// archivos fuente. Etapa de ARCHIVOS solamente: el ledger lo escribe
// import-movimientos-ar.ts (con su gate de totales) en el paso siguiente.
//
// Uso:  npx tsx scripts/sync-caja-ar.ts [--xlsx <caja.xlsx> | --raw <raw.json>] [--apply]
//       (sin --xlsx/--raw usa CAJA_AR_URL/CAJA_AR_SECRET de finanzas/.env.local)
import { config } from "dotenv";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
config({ path: resolve(__dirname, "../.env.local") });

type Mov = { fecha: string; mes: number; tipo: string; ars: number; usd: number };

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rawDestino = resolve(__dirname, "../seed-data/caja_ar_raw.json");
  const movsDestino = resolve(__dirname, "../seed-data/movimientos_ar_2026.json");
  const rawTmp = "/tmp/caja_ar_raw_nuevo.json";
  const movsTmp = "/tmp/caja_ar_movs_nuevo.json";

  const xlsx = argValor("xlsx");
  const rawArg = argValor("raw");
  if (xlsx) {
    execFileSync("python3", [resolve(__dirname, "parse_caja.py"), "--xlsx-a-raw", xlsx, rawTmp], { stdio: "inherit" });
  } else if (rawArg) {
    copyFileSync(resolve(rawArg), rawTmp);
  } else {
    const url = process.env.CAJA_AR_URL, secret = process.env.CAJA_AR_SECRET;
    if (!url || !secret) {
      console.error(
        "Falta CAJA_AR_URL / CAJA_AR_SECRET en finanzas/.env.local (Apps Script sin instalar).\n" +
        "Instalación: scripts/gas-caja-ar.gs — o correr con --xlsx <export de la caja>."
      );
      process.exit(2);
    }
    const res = await fetch(`${url}?secret=${encodeURIComponent(secret)}`);
    const texto = await res.text();
    if (!res.ok || texto === "no") throw new Error(`Apps Script respondió ${res.status}: ${texto.slice(0, 120)}`);
    const j = JSON.parse(texto);
    if (!j.tabs || !Object.keys(j.tabs).length) throw new Error("respuesta sin pestañas");
    writeFileSync(rawTmp, texto);
  }

  execFileSync("python3", [resolve(__dirname, "parse_caja.py"), "--raw-a-movs", rawTmp, movsTmp], { stdio: "inherit" });

  // GATE: un mes cerrado no puede achicarse (si Claudia borra filas viejas,
  // esto tiene que mirarlo un humano — abortamos sin tocar los archivos).
  const viejos = JSON.parse(readFileSync(movsDestino, "utf8")) as Mov[];
  const nuevos = JSON.parse(readFileSync(movsTmp, "utf8")) as Mov[];
  const totales = (ms: Mov[]) => {
    const t = new Map<string, number>();
    for (const m of ms) {
      if (m.tipo !== "cobro") continue;
      for (const [cur, monto] of [["ars", m.ars], ["usd", m.usd]] as const) {
        if (!monto) continue;
        const k = `${m.mes}-${cur}`;
        t.set(k, (t.get(k) ?? 0) + monto);
      }
    }
    return t;
  };
  const tv = totales(viejos), tn = totales(nuevos);
  const mesActual = new Date().getMonth() + 1;
  const regresiones: string[] = [];
  for (const [k, v] of tv) {
    const mes = Number(k.split("-")[0]);
    if (mes >= mesActual) continue;
    const n = tn.get(k) ?? 0;
    if (n < v - 0.005) regresiones.push(`mes ${k}: ${v.toLocaleString("es-AR")} → ${n.toLocaleString("es-AR")}`);
  }
  if (regresiones.length) {
    console.error("✗ GATE: meses cerrados se achicaron — NO se escribe nada:");
    for (const r of regresiones) console.error("   ", r);
    process.exit(1);
  }

  const antes = viejos.length, despues = nuevos.length;
  console.log(`movimientos: ${antes} → ${despues} (${despues - antes >= 0 ? "+" : ""}${despues - antes})`);
  if (!apply) {
    console.log("(dry-run — archivos sin tocar; correr con --apply)");
    return;
  }
  copyFileSync(rawTmp, rawDestino);
  copyFileSync(movsTmp, movsDestino);
  console.log("✓ seed-data/caja_ar_raw.json y movimientos_ar_2026.json actualizados");
  console.log("  siguiente paso de la cadena: import-movimientos-ar.ts --apply --yes");
}

main().catch((e) => { console.error(e); process.exit(1); });

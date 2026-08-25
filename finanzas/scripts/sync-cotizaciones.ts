/**
 * Baja el histórico del dólar blue de Ámbito y lo guarda en fx_rates.
 *
 *   npx tsx scripts/sync-cotizaciones.ts [--desde 2026-01-01] [--hasta 2026-08-25] [--apply]
 *
 * Sin --desde arranca en el primer movimiento en dólares que haya en la base
 * (no tiene sentido guardar cotizaciones de años sin plata que convertir).
 * Sin --apply sólo muestra qué escribiría.
 *
 * Idempotente: la clave es (source, quote_date), así que correrlo dos veces
 * pisa los mismos días con los mismos valores. Ámbito puede corregir un cierre
 * publicado; por eso el upsert actualiza en vez de ignorar.
 */
import { serviceClient, upsertBatched, argFlags } from "./lib/service-client";
import { FUENTE_TC, parseAmbito, urlAmbito, tcDe } from "../lib/fx";

function argValor(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const { apply } = argFlags();
  const db = await serviceClient({
    accion: "sincronizar cotizaciones del blue (Ámbito)",
    auto: !apply,
  });

  const hasta = argValor("hasta") ?? hoyISO();
  let desde: string | undefined = argValor("desde");
  if (!desde) {
    const { data } = await db.from("movements").select("occurred_on")
      .eq("currency", "USD").order("occurred_on", { ascending: true }).limit(1);
    desde = (data?.[0]?.occurred_on as string | undefined) ?? `${hasta.slice(0, 4)}-01-01`;
  }
  const inicio: string = desde;
  if (inicio > hasta) throw new Error(`rango vacío: desde ${inicio} > hasta ${hasta}`);

  const url = urlAmbito(inicio, hasta);
  console.log(`Ámbito ${inicio} → ${hasta}\n  ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (finanzas-ks)" } });
  if (!res.ok) throw new Error(`Ámbito respondió ${res.status}`);
  const cotizaciones = parseAmbito(await res.json());

  // El rango pedido lo respeta el que llama, no la fuente: Ámbito a veces
  // devuelve algún día de más en los bordes.
  const filas = cotizaciones
    .filter((c) => c.fecha >= inicio && c.fecha <= hasta)
    .map((c) => ({ source: FUENTE_TC, quote_date: c.fecha, buy: c.compra, sell: c.venta }));
  if (!filas.length) throw new Error("Ámbito no devolvió ninguna cotización del rango pedido");

  const primera = cotizaciones[0], ultima = cotizaciones[cotizaciones.length - 1];
  console.log(
    `${filas.length} ruedas · ${primera.fecha} t/c ${tcDe(primera)} → ` +
    `${ultima.fecha} t/c ${tcDe(ultima)}`
  );

  if (!apply) {
    console.log("\n(dry-run: no se escribió nada — repetir con --apply)");
    return;
  }
  const n = await upsertBatched(db, "fx_rates", filas, "source,quote_date");
  console.log(`✓ ${n} cotizaciones guardadas en fx_rates`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

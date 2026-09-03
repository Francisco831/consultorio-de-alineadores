// Costeo KS de las cuotas de alineadores y liquidación de las doctoras.
// Port FIEL de costear() y build_xlsx() de consultorio-gestion/build_liquidaciones.py
// (reglas de Pancho del 21/7/2026). Validado contra la salida de ese script.
//
// CAMBIOS DE CRITERIO (Pancho, 24/8/26) sobre el port original:
//  1. LISTA HISTÓRICA: el costo KS total de un caso es el de la lista vigente
//     cuando ENTRÓ el caso, no la actual. La fecha de ingreso real viene de
//     Noloco (tipos_tratamiento_ar.json); si falta, se infiere de la primera
//     cuota visible retrocediendo N−1 meses cuando declara "cuota N de Y".
//  2. COSTO PROPORCIONAL A LO COBRADO: cada cobro de alineadores descuenta
//     costo_total × (monto / precio_pactado) — "entró x plata, corresponde este
//     costo" — con tope acumulado en el costo total. No importa el número de
//     cuotas ni si un pago es parcial o doble: el porcentaje manda. El precio
//     pactado sale del override PRECIO_PACTADO o se infiere como plan × valor
//     de la PRIMERA cuota limpia (el pacto es el del ingreso; las cuotas
//     siguientes ya vienen ajustadas por inflación).
//
//  3. TODO SE PESIFICA (Pancho, 25/8/26): un cobro en dólares se convierte a
//     pesos al blue de SU fecha —promedio comprador/vendedor de Ámbito, ver
//     lib/fx.ts— y la doctora cobra un solo número en pesos. Antes el t/c salía
//     del "t/c 1510" que alguien hubiera escrito en el motivo, y sin eso de una
//     constante: dos cobros del mismo día podían valer distinto según quién
//     cargó la fila. Ahora el t/c de la fila es sólo una red por si falta la
//     cotización de esa fecha.
//
// Detalles que siguen importando:
//  - La identidad del paciente son sus tokens ORDENADOS de más de 2 letras: así
//    "Pérez Viviana", "perez viviana" y "Viviana Perez" son la misma persona.
//  - El porcentaje del tratamiento que representa un cobro se calcula en la
//    moneda del PACTO (un cobro en dólares contra un pacto en dólares no pasa
//    por el t/c): pesificar antes de prorratear haría que el mismo cobro valga
//    otro porcentaje según cómo se movió el dólar.
//  - El orden de las filas decide qué cuota define el pacto y dónde muerde el
//    tope; por eso los movimientos sembrados guardan su fila en meta.seq.

import { norm } from "../import/normalize";

export const RE_CUOTA = /c(?:uo)?ta\s*\.?\s*(\d+)\s*de\s*(\d+)/i;
export const RE_CUOTA_DOBLE = /c(?:uo)?tas?\s*(\d+)\s*y\s*(\d+)\s*de\s*(\d+)/i;
export const RE_TC = /t\/?c\s*\$?\s*([\d.,]+)/i;
// "parte de cuota 3", "a cta de cuota 2", "resto/saldo de cuota": el monto NO es
// una cuota entera — no sirve para inferir el valor de cuota del pacto
export const RE_PARCIAL = /\bparte\b|\bresto\b|\bsaldo\b|\bseña\b|\ba\s*c(?:uo|uen)?ta\.?\s*de\b/i;

// Una CONTENCIÓN o una placa suelta no lleva costo KS (Pancho, 26/8/26). La
// caja las carga bajo "Alineadores" —son del mismo paciente y del mismo
// tratamiento— y el costeo las trataba como una cuota sin precio: quedaban
// "SIN COSTEAR", que es como decir costo $0 pero con un cartel de alarma al
// lado. Son 7 de los 12 casos sin costear al 26/8/26.
export const RE_CONTENCION = /contenci[oó]n|placa\s*bis/i;

// Un cobro que declara pagar el TRATAMIENTO ENTERO vale el 100% del caso
// (Pancho, 2/9/26). Es el cobro de Castiglioni Isabella del 28/8: "Abona total
// tratamiento U$S 2600 con 10% descuento" — un solo pago, sin pacto cargado y
// sin "cuota N de Y". El costeo no tenía de dónde sacar un porcentaje: lo
// dejaba SIN COSTEAR con costo $0 y a la doctora se le liquidaba el 40% del
// BRUTO ($1.455.480 en vez de $800.040 en esa línea).
//
// La regla tapa además un agujero que todavía no explotó: con el pacto cargado
// al precio de LISTA, un pago total CON descuento prorratea 90% y el 10% de
// costo que falta no lo carga nunca nadie, porque no vienen más cobros.
//
// Formas que la caja YA escribió: "Abona total tratamiento", "Abona  total del
// tratamiento", "Abona tratamiento completo", "Abona el tratamiento con 10% de
// descuento". Se agregan las que va a escribir: "paga el total", "pago total",
// "cancela el tratamiento".
//
// Lo que NO entra: "total" suelto (la caja escribe importes con esa palabra) ni
// "contado" suelto — "abona de contado" describe el MEDIO de pago, no que haya
// pagado el tratamiento entero, y la caja nunca lo usó con ese sentido.
export const RE_TOTAL =
  /\b(?:abona|abono|paga|pag[oó]|cancela)\s+(?:el\s+|la\s+|su\s+|todo\s+el\s+)?(?:total(?:idad)?|trat(?:amiento)?)\b|\btotal(?:idad)?\s+(?:d?el\s+)?trat(?:amiento)?\b|\btrat(?:amiento)?\s+(?:completo|entero|[ií]ntegro)\b/i;

/**
 * Cuánto del precio conocido tiene que cubrir un cobro para creerle que paga el
 * tratamiento entero. Con un descuento de contado, redondeos o un adelanto
 * previo, un pago "total" puede quedar bastante abajo del precio de lista; con
 * menos que esto ya no es un pago total, es una seña escrita de más.
 */
export const UMBRAL_PAGO_TOTAL = 0.7;

// Cualquier mención a una cuota saca al cobro de la regla del total: "Abona el
// tratamiento en 6 cuotas" describe el PLAN, y "cuota 6 de 6, cancela el
// tratamiento" es la última cuota, no el 100%. Es a propósito más ancha que
// RE_CUOTA (que exige "N de Y"): acá conviene no disparar de más —se cae al
// camino de siempre— antes que cargarle el caso entero a un pago parcial.
const RE_MENCIONA_CUOTA = /\bc(?:uo)?tas?\b/i;

/** Último recurso: no hay cotización de esa fecha NI t/c escrito en la fila. */
export const TC_FALLBACK = 1500;

/** Identidad del paciente: tokens ordenados de más de 2 letras. */
export function clavePaciente(nombre: string): string {
  return norm(nombre)
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .sort()
    .join(" ");
}

export type PrecioKS = { list_price: number; discount_pct: number };

/** Lista de precios KS vigente desde una fecha: "audience/scope/arcades" → precio. */
export type ListaPrecios = { validFrom: string; precios: Map<string, PrecioKS> };

/** "la gran gran mayoría son Full bimaxilar" */
export const TIPO_DEFAULT = "adultos/full/2";

/** Resta n meses a una fecha ISO (estimación de ingreso desde "cuota N de Y"). */
function restarMeses(fecha: string, n: number): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
}

export type CobroAlineador = {
  id: string;
  paciente: string;
  fecha: string;
  ars: number;
  usd: number;
  motivo: string;  // SOLO el motivo: distingue dos cuotas del mismo día e importe
  texto: string;   // motivo + obs (para leer "cuota X de Y")
  seq: number;     // orden original de la fila
};

export type ResultadoCosteo = {
  /** Costo KS por cobro, SIEMPRE en pesos (la lista KS es en pesos). */
  costoArs: Map<string, number>;
  etiquetas: Map<string, string>;
  sinCostear: number;
};

export function costearCuotas(
  cobros: CobroAlineador[],
  opts: {
    precioDefault: PrecioKS;
    listas?: ListaPrecios[];                   // historial de listas KS con vigencia
    tipoPorPaciente?: Map<string, string>;     // clave paciente → "audience/scope/arcades" (Noloco)
    ingresoPorPaciente?: Map<string, string>;  // clave paciente → fecha de ingreso del caso (Noloco)
    planPorPaciente?: Record<string, number>;
    precioPactado?: Record<string, number>;     // nombre → precio total pactado en ARS
    precioPactadoUsd?: Record<string, number>;  // nombre → precio total pactado en USD
    etapaAdicional?: Set<string>;
    // nombre → precio de su ETAPA ADICIONAL. Gana sobre la lista de precios y
    // sobre la regla de "etapa adicional sin costo": la etapa sólo es gratis
    // cuando el tratamiento era Full.
    costoEtapaAdicional?: Record<string, number>;
    // nombre → % de descuento EXTRA sobre el costo KS de lista, para los casos
    // que la fábrica factura más barato que el precio de lista.
    descuentoKsEspecial?: Record<string, number>;
    // Blue de cada fecha (lib/fx.ts). Sin esto, el costeo cae al t/c escrito en
    // la fila y después a TC_FALLBACK — que es exactamente lo que la regla del
    // 25/8/26 vino a sacar del medio.
    tcPorFecha?: (fecha: string) => number | undefined;
    // Costo KS escrito a mano para UN cobro (migración 0030), en pesos.
    // Entra acá y no después de esta función a propósito: el tope por caso vive
    // en el Map `acumulado` de más abajo, que es local. Un costo puesto afuera
    // no lo consume, así que las cuotas siguientes del mismo paciente volverían
    // a imputar su share automático y el caso cargaría su costo DOS VECES —
    // plata de la doctora, en silencio.
    costoManualArs?: Map<string, { monto: number; motivo: string }>;
  }
): ResultadoCosteo {
  // Ingreso del caso por paciente: manda la fecha real de Noloco; si falta, se
  // infiere de la primera cuota visible (si declara "cuota N de Y", el caso
  // entró ~N−1 meses antes). Esto decide QUÉ lista de precios paga el caso.
  const ingresoInferido = new Map<string, string>();
  for (const c of [...cobros].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.seq - b.seq)) {
    const k = clavePaciente(c.paciente);
    if (ingresoInferido.has(k)) continue;
    const n = Number(RE_CUOTA_DOBLE.exec(c.texto)?.[1] ?? RE_CUOTA.exec(c.texto)?.[1] ?? 1);
    ingresoInferido.set(k, n > 1 ? restarMeses(c.fecha, n - 1) : c.fecha);
  }
  const listas = [...(opts.listas ?? [])].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const costoFijado = new Map<string, number>();
  for (const [nombre, v] of Object.entries(opts.costoEtapaAdicional ?? {})) {
    costoFijado.set(clavePaciente(nombre), v);
  }
  /** Full incluye las etapas adicionales (programa 1 a 4). Medium y Fast no. */
  const esFull = (k: string) =>
    (opts.tipoPorPaciente?.get(k) ?? TIPO_DEFAULT).split("/")[1] === "full";
  const descuentoEspecial = new Map<string, number>();
  for (const [nombre, v] of Object.entries(opts.descuentoKsEspecial ?? {})) {
    descuentoEspecial.set(clavePaciente(nombre), v);
  }
  // Normalizado como todo lo demás: escrito "Fernanda Cugat" o "Cugat
  // Fernanda", es el mismo caso. Sin esto, la variante que no estuviera en el
  // orden alfabético de clavePaciente() no matcheaba nunca, y el Set sólo
  // funcionaba por tener cargadas las dos grafías.
  const etapaSinCosto = new Set(
    [...(opts.etapaAdicional ?? [])].map((n) => clavePaciente(n))
  );

  /** La lista que le toca a un caso: la vigente a su ingreso, para su tipo. */
  const listaDe = (k: string): PrecioKS => {
    if (!listas.length) return opts.precioDefault;
    const fecha = opts.ingresoPorPaciente?.get(k) ?? ingresoInferido.get(k) ?? "";
    const lista = listas.filter((l) => l.validFrom <= fecha).pop() ?? listas[0];
    return lista.precios.get(opts.tipoPorPaciente?.get(k) ?? TIPO_DEFAULT) ?? opts.precioDefault;
  };

  // precio del caso: lista vigente a su ingreso + tipo real de tratamiento
  // (Noloco); sin datos cae al default Full 2 maxilares adultos a lista actual.
  // Un caso anterior a la lista más vieja conocida usa esa (no hay mejor dato).
  const costoDe = (k: string) => {
    const pr = listaDe(k);
    // El precio declarado de una etapa adicional es DE LISTA, igual que el de
    // un tratamiento: la doctora la paga con el mismo 40% de descuento (regla
    // de Pancho, 26/8/26 — la etapa de un Medium sale $498.000 y se imputa
    // $298.800). El descuento especial por paciente no se le encima: el precio
    // de la etapa se declaró para ese caso puntual.
    const fijado = costoFijado.get(k);
    if (fijado != null) return fijado * (1 - pr.discount_pct / 100);
    const deLista = pr.list_price * (1 - pr.discount_pct / 100);
    return deLista * (1 - (descuentoEspecial.get(k) ?? 0) / 100);
  };
  const costoArs = new Map<string, number>();
  const etiquetas = new Map<string, string>();
  let sinCostear = 0;

  // plan por paciente: el máximo "de Y" que alguna de sus filas declare
  // (solo se usa para armar el precio pactado: plan × valor de cuota)
  const plan = new Map<string, number>();
  for (const c of cobros) {
    const y = Number(RE_CUOTA_DOBLE.exec(c.texto)?.[3] ?? RE_CUOTA.exec(c.texto)?.[2] ?? 0);
    if (y > 0) {
      const k = clavePaciente(c.paciente);
      plan.set(k, Math.max(plan.get(k) ?? 0, y));
    }
  }
  for (const [nombre, n] of Object.entries(opts.planPorPaciente ?? {})) {
    plan.set(clavePaciente(nombre), n);
  }
  const pactado = new Map<string, number>();
  for (const [nombre, v] of Object.entries(opts.precioPactado ?? {})) {
    pactado.set(clavePaciente(nombre), v);
  }
  const pactadoUsd = new Map<string, number>();
  for (const [nombre, v] of Object.entries(opts.precioPactadoUsd ?? {})) {
    pactadoUsd.set(clavePaciente(nombre), v);
  }

  // Valor de UNA cuota por paciente y moneda: la primera fila LIMPIA que declara
  // "cuota X de Y" (ni parcial ni doble a medias — una doble vale monto/2). Se
  // toma la primera porque el precio pactado es el del INGRESO del caso: las
  // cuotas se ajustan por inflación y las siguientes ya no representan el pacto.
  const cuotaBase = new Map<string, number>();   // `${k}|${ARS|USD}` → valor cuota
  for (const c of [...cobros].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.seq - b.seq)) {
    const k = clavePaciente(c.paciente);
    const cur = c.ars > 0 ? "ARS" : "USD";
    const kk = `${k}|${cur}`;
    if (cuotaBase.has(kk) || RE_PARCIAL.test(c.texto)) continue;
    const monto = c.ars > 0 ? c.ars : c.usd;
    if (RE_CUOTA_DOBLE.test(c.texto)) cuotaBase.set(kk, monto / 2);
    else if (RE_CUOTA.test(c.texto)) cuotaBase.set(kk, monto);
  }

  // Costo proporcional a la plata cobrada (regla Pancho 24/8/26): cada cobro
  // descuenta costo_total × (monto / precio_pactado), con tope acumulado en el
  // costo total del caso — al pagar el 100% se descontó exactamente el 100%.
  const acumulado = new Map<string, number>();   // k → costo ya imputado (ARS)
  for (const c of [...cobros].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.seq - b.seq)) {
    const k = clavePaciente(c.paciente);
    const texto = c.texto;

    // Un costo escrito a mano le gana a TODAS las reglas de abajo (contención,
    // etapa adicional, pacto, plan × cuota): si alguien se sentó a poner el
    // número, ese es el número. No se clampea al costo del caso —clampear sería
    // ignorar en silencio lo que se escribió— pero SÍ consume el acumulador,
    // así que si se pasa, las cuotas siguientes del caso quedan en $0 solas y
    // lo dicen en su etiqueta ("tope: el caso ya cargó su costo completo").
    const manual = opts.costoManualArs?.get(c.id);
    if (manual) {
      acumulado.set(k, (acumulado.get(k) ?? 0) + manual.monto);
      costoArs.set(c.id, Math.round(manual.monto));
      etiquetas.set(
        c.id,
        `costo KS $${Math.round(manual.monto).toLocaleString("es-AR")} puesto a mano` +
        (manual.motivo ? ` — ${manual.motivo}` : "")
      );
      continue;
    }

    // La etapa adicional viene incluida en el programa 1 a 4 — pero eso vale
    // para los tratamientos FULL. En un Medium o un Fast la etapa se cobra
    // aparte y tiene su propio precio (Pancho, 25/8/26, sobre Daira Castellón).
    //
    // Declarar el caso en ETAPA_ADICIONAL es decidir sobre ESE caso, y le gana
    // al tipo de tratamiento: el tipo puede faltar en Noloco o venir mal, y no
    // debería hacerle cargar un costo a un caso declarado sin costo.
    // Una contención no es una cuota del tratamiento: no cuesta. Se pide además
    // que la fila NO declare "cuota N de Y" para no perderle el costo a un cobro
    // que sea las dos cosas ("cuota 3 de 6 + contención").
    if (RE_CONTENCION.test(texto) && !RE_CUOTA.test(texto)) {
      etiquetas.set(c.id, "contención o placa suelta: sin costo KS");
      continue;
    }

    const declaradaSinCosto = etapaSinCosto.has(k);
    if (!costoFijado.has(k) &&
        (norm(texto).includes("etapa adicional") || declaradaSinCosto)) {
      if (declaradaSinCosto || esFull(k)) {
        etiquetas.set(c.id, "etapa adicional: sin costo (incluida en programa 1 a 4)");
      } else {
        // Callarse acá sería regalar el costo: se marca para que alguien lo cargue.
        etiquetas.set(c.id, "SIN COSTEAR: etapa adicional de un tratamiento no-Full, falta su precio");
        sinCostear++;
      }
      continue;
    }

    const cur = c.ars > 0 ? "ARS" : "USD";
    const monto = c.ars > 0 ? c.ars : c.usd;
    // El t/c manda desde la serie del blue, no desde lo que diga la fila: dos
    // cobros del mismo día tienen que cruzarse al mismo dólar. El "t/c 1510"
    // escrito a mano queda de red para una fecha sin cotización, y recién
    // después la constante.
    const tcm = RE_TC.exec(texto);
    const tcFila = tcm ? Number(tcm[1].replace(/\./g, "").replace(",", ".")) : undefined;
    const candidatos = [opts.tcPorFecha?.(c.fecha), tcFila, TC_FALLBACK];
    let tc = candidatos.find((v) => Number.isFinite(v) && (v as number) >= 100) as number;
    if (tc == null) tc = TC_FALLBACK;

    // % del tratamiento que representa este cobro. El pacto declarado a mano
    // gana (en su moneda: Hogner paga en pesos un pacto en USD → se cruza al
    // t/c de la fila); si no hay pacto, plan × valor de cuota en la MISMA
    // moneda del cobro.
    const pArs = pactado.get(k), pUsd = pactadoUsd.get(k);
    const base = cuotaBase.get(`${k}|${cur}`);
    // ¿La fila dice que paga el tratamiento entero? Se le piden tres cosas más:
    // que no sea un pago parcial ("abona resto del tratamiento" es el 51%, no el
    // 100%), que no hable de cuotas, y que no sea de una etapa o tratamiento
    // ADICIONAL —"cuota 1 de 2 de tratamiento adicional"—, que tiene sus propias
    // reglas más arriba.
    //
    // Y una cuarta, que es la que evita el daño caro: si el precio del caso se
    // CONOCE, el cobro tiene que llegar a cubrirlo. Elisa Gonzalez Alzaga tiene
    // dos filas del 21/1/26 con el mismo texto "Abona  total del tratamiento":
    // una de $75.000 y otra de US$ 2.200. Sin esta prueba, la de $75.000 —que
    // viene primera por seq— se lleva el costo entero del caso y se imprime con
    // un neto de −$1.400.000, y la de US$ 2.200 queda en $0 por el tope. El
    // texto puede mentir sobre lo que se pagó; el monto contra el pacto, no.
    const precioConocido =
      cur === "ARS" ? (pArs ?? (pUsd != null ? pUsd * tc : undefined))
                    : (pUsd ?? (pArs != null ? pArs / tc : undefined));
    const precioReferencia =
      precioConocido ?? (plan.has(k) && base ? plan.get(k)! * base : undefined);
    const pagaTodo =
      RE_TOTAL.test(texto) && !RE_PARCIAL.test(texto) &&
      !RE_MENCIONA_CUOTA.test(texto) && !norm(texto).includes("adicional") &&
      (precioReferencia == null || monto >= precioReferencia * UMBRAL_PAGO_TOTAL);
    let pct: number | undefined;
    let precioTxt = "";
    // Una etapa adicional con precio declarado NO se prorratea: KS la factura de
    // una vez, así que su costo se imputa ENTERO en el primer cobro que la paga
    // (regla de Pancho, 26/8/26). Las cuotas siguientes de esa misma etapa
    // quedan en cero por el tope acumulado de más abajo.
    if (costoFijado.has(k)) { pct = 1; }
    // Le gana al pacto a propósito: si el pacto quedó cargado al precio de LISTA
    // y el paciente pagó con descuento, prorratear dejaría un pedazo del costo
    // KS sin cargarle a nadie —y no vienen más cobros de ese caso—. El tope
    // acumulado de más abajo evita el doble cobro si el caso ya cargó su costo.
    else if (pagaTodo) { pct = 1; }
    else if (cur === "ARS" && pArs) { pct = monto / pArs; precioTxt = `$${pArs.toLocaleString("es-AR")}`; }
    else if (cur === "USD" && pUsd) { pct = monto / pUsd; precioTxt = `USD ${pUsd.toLocaleString("es-AR")}`; }
    else if (cur === "ARS" && pUsd) { pct = monto / tc / pUsd; precioTxt = `USD ${pUsd.toLocaleString("es-AR")} (t/c ${tc})`; }
    else if (cur === "USD" && pArs) { pct = (monto * tc) / pArs; precioTxt = `$${pArs.toLocaleString("es-AR")} (t/c ${tc})`; }
    else if (plan.has(k) && base) {
      const precio = plan.get(k)! * base;
      pct = monto / precio;
      precioTxt = `${cur === "USD" ? "USD " : "$"}${precio.toLocaleString("es-AR")} inferido`;
    }
    if (pct == null || !Number.isFinite(pct) || pct <= 0) {
      etiquetas.set(c.id, "SIN COSTEAR: sin precio pactado ni plan × cuota inferible");
      sinCostear++;
      continue;
    }

    const costoTotal = costoDe(k);
    const ya = acumulado.get(k) ?? 0;
    const share = Math.min(costoTotal * pct, Math.max(0, costoTotal - ya));
    acumulado.set(k, ya + share);

    const tope = share + 0.5 < costoTotal * pct ? " — tope: el caso ya cargó su costo completo" : "";
    const dto = descuentoEspecial.get(k);
    const especial = dto ? ` · ${dto}% de descuento especial sobre el costo KS` : "";
    // La etapa adicional cuenta su propia historia: precio de lista y descuento,
    // que es de donde sale el número. Un "100% del precio" no diría nada.
    const pctTxt = costoFijado.has(k)
      ? `etapa adicional: $${costoFijado.get(k)!.toLocaleString("es-AR")} de lista ` +
        `menos ${listaDe(k).discount_pct}%`
      : pagaTodo
      ? "el cobro paga el tratamiento entero: 100% del caso"
      : `${(pct * 100).toLocaleString("es-AR", { maximumFractionDigits: 1 })}% del precio ${precioTxt}`;
    // El costo va en pesos aunque el cobro haya entrado en dólares: `share` sale
    // de la lista KS, que está en pesos, y la liquidación es un solo número.
    // (el "US$ 360 × t/c 1.505" lo agrega recalcular.ts, que pesifica todo lo
    // que entra a la liquidación, no sólo los cobros de alineadores)
    costoArs.set(c.id, Math.round(share));
    etiquetas.set(
      c.id,
      `costo KS $${Math.round(share).toLocaleString("es-AR")} (${pctTxt}${tope}${especial})`
    );
  }

  return { costoArs, etiquetas, sinCostear };
}

// Desde el 25/8/26 una liquidación es UN número en pesos: los cobros en dólares
// entran acá ya pesificados al blue de su fecha (lib/fx.ts). Por eso no hay
// bucket USD — tenerlo obligaría a decidir en cada pantalla si se suma o no, y
// esa duda es la que hacía que la planilla y el sistema no cerraran.
export type LineaLiquidacion = {
  doctora: string;
  periodo: string;
  cobradoArs: number;
  gastosTratamiento: number;   // costo KS en ARS
  baseArs: number;
  liquidacionArs: number;
  retiros: number;
  saldo: number;
};

export type MovimientoLiq = {
  id: string;
  doctora: string | null;
  periodo: string;
  ars: number;   // ya pesificado si el movimiento era en dólares
  tipo: "cobro" | "retiro_liquidacion" | "gasto_tratamiento" | "otro";
};

export function calcularLiquidaciones(
  movimientos: MovimientoLiq[],
  costoArs: Map<string, number>,
  pctPorDoctora: (doctora: string) => number
): LineaLiquidacion[] {
  const acc = new Map<string, LineaLiquidacion>();
  for (const m of movimientos) {
    if (!m.doctora) continue;
    const k = `${m.doctora}|${m.periodo}`;
    if (!acc.has(k)) {
      acc.set(k, {
        doctora: m.doctora, periodo: m.periodo, cobradoArs: 0,
        gastosTratamiento: 0, baseArs: 0, liquidacionArs: 0, retiros: 0, saldo: 0,
      });
    }
    const l = acc.get(k)!;
    if (m.tipo === "cobro") {
      l.cobradoArs += m.ars;
      l.gastosTratamiento += costoArs.get(m.id) ?? 0;
    } else if (m.tipo === "retiro_liquidacion") {
      l.retiros += m.ars;
    } else if (m.tipo === "gasto_tratamiento") {
      l.gastosTratamiento += m.ars;
    }
  }
  for (const l of acc.values()) {
    const pct = pctPorDoctora(l.doctora) / 100;
    l.baseArs = Math.round((l.cobradoArs - l.gastosTratamiento) * 100) / 100;
    l.liquidacionArs = Math.round(l.baseArs * pct);
    l.saldo = Math.round(l.liquidacionArs - l.retiros);
  }
  return [...acc.values()].sort(
    (a, b) => a.periodo.localeCompare(b.periodo) || a.doctora.localeCompare(b.doctora)
  );
}

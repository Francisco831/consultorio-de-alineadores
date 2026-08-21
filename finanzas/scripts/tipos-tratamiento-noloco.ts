// Busca en Noloco (keepsmiling-v2) el caso de cada paciente de Alineadores del
// consultorio y deriva su tipo real de tratamiento para el costeo KS:
//   scope   = token FULL/MEDIUM/FAST/LITTLE de etapaTratamiento{Superior,Inferior}
//   arcades = maxilares AMBOS→2, un maxilar→1
//   audience= TEEN/KID en el token → teens/kids; si no, adultos
// Escribe seed-data/tipos_tratamiento_ar.json (lo consume liquidaciones.ts).
// El match es por nombre normalizado con tokens ordenados (mismo criterio que
// el costeo); ante varios casos gana el más nuevo de ARGENTINA.
//
// Uso:  npx tsx scripts/tipos-tratamiento-noloco.ts          (busca y muestra)
//       npx tsx scripts/tipos-tratamiento-noloco.ts --apply  (además escribe el JSON)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient, fetchAllRows, argFlags } from "./lib/service-client";
import { clavePaciente } from "../lib/liquidaciones/costeo";

const API = "https://api.portals.noloco.io/data/keepsmiling-v2";
const OUT = resolve(__dirname, "../seed-data/tipos_tratamiento_ar.json");

function credenciales(): { email: string; password: string } {
  const env = readFileSync(resolve(__dirname, "../../tracer/.env"), "utf8");
  const leer = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
  const email = leer("KEEPSMILING_EMAIL"), password = leer("KEEPSMILING_PASSWORD");
  if (!email || !password) throw new Error("faltan KEEPSMILING_EMAIL/PASSWORD en tracer/.env");
  return { email, password };
}

async function gql<T>(query: string, variables: object, token?: string): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "x-noloco-project": "keepsmiling-v2",
      "x-noloco-ghost": "false", ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const d = (await res.json()) as { data: T; errors?: unknown[] };
  if (d.errors?.length) throw new Error(JSON.stringify(d.errors).slice(0, 300));
  return d.data;
}

type Caso = {
  idExterno: string; paciente: string; pais: string; maxilares: string | null;
  etapaTratamientoSuperior: string | null; etapaTratamientoInferior: string | null;
  fechaIngreso: string; doctores: { nombre: string } | null;
};

function derivar(c: Caso): { audience: string; scope: string; arcades: number } | null {
  const texto = `${c.etapaTratamientoSuperior ?? ""} ${c.etapaTratamientoInferior ?? ""}`.toUpperCase();
  const scope = texto.match(/\b(FULL|MEDIUM|FAST|LITTLE)\b/)?.[1]?.toLowerCase();
  if (!scope) return null;
  const audience = /TEEN/.test(texto) ? "teens" : /KID/.test(texto) ? "kids" : "adultos";
  const arcades = c.maxilares === "AMBOS" ? 2 : 1;
  return { audience, scope: scope === "little" ? "fast" : scope, arcades };
}

async function main() {
  const flags = argFlags();
  const db = await serviceClient({ accion: "buscar tipos de tratamiento en Noloco", auto: flags.yes });
  const { data: ar } = await db.from("companies").select("id").eq("slug", "ar").single();
  const { data: cat } = await db.from("categories").select("id")
    .eq("company_id", ar!.id).eq("name", "Alineadores").single();
  const movs = await fetchAllRows<{ counterparty: { display_name: string } | null }>(
    db, "movements", "counterparty:counterparties(display_name)",
    (q) => q.eq("company_id", ar!.id).eq("kind", "income").eq("category_id", cat!.id).neq("status", "void"));
  // los nombres de la caja traen basura (DNI pegado, "no hacer factura"): se
  // limpia antes de armar la clave
  const limpiar = (n: string) => n.replace(/\d+/g, " ").replace(/no hacer factura.*/i, "").trim();
  const pacientes = new Map<string, string>();   // clave -> nombre visible
  for (const m of movs) {
    const n = (m.counterparty as { display_name?: string } | null)?.display_name?.trim();
    if (n) pacientes.set(clavePaciente(limpiar(n)), limpiar(n));
  }
  console.log(`${pacientes.size} pacientes de alineadores para buscar en Noloco`);

  const { email, password } = credenciales();
  const login = await gql<{ login: { token: string } }>(
    "mutation l($e:String!,$p:String!){login(email:$e,password:$p){token}}",
    { e: email, p: password });
  const token = login.login.token;

  const CAMPOS = "idExterno paciente pais maxilares etapaTratamientoSuperior etapaTratamientoInferior fechaIngreso doctores { nombre }";
  const tipos: Record<string, { paciente: string; case: string; doctora: string | null; audience: string; scope: string; arcades: number }> = {};
  let sinCaso = 0, sinTipo = 0;
  for (const [clave, nombre] of pacientes) {
    // se busca por el token más largo del nombre (mejor selectividad)
    const tokenBusqueda = nombre.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    const d = await gql<{ keepsmilingCasosCollection: { edges: { node: Caso }[] } }>(
      `query b($t:String) { keepsmilingCasosCollection(first: 20,
        where: { paciente: {contains: $t}, pais: {equals: "ARGENTINA"} },
        orderBy: {field: "fechaIngreso", direction: DESC}) {
        edges { node { ${CAMPOS} } } } }`, { t: tokenBusqueda }, token);
    const tokensCaja = new Set(clave.split(" "));
    const candidatos = d.keepsmilingCasosCollection.edges
      .map((e) => e.node)
      .filter((c) => {
        const cn = clavePaciente(limpiar(c.paciente));
        if (cn === clave) return true;
        // subset: "maria fernanda cugat" (caja) vs "cugat fernanda" (noloco) o al revés
        const tokensNoloco = cn.split(" ");
        const chicos = tokensNoloco.length <= tokensCaja.size ? tokensNoloco : [...tokensCaja];
        const grandes = tokensNoloco.length <= tokensCaja.size ? tokensCaja : new Set(tokensNoloco);
        return chicos.length >= 2 && chicos.every((t) => grandes.has(t));
      });
    if (!candidatos.length) { sinCaso++; console.log(`   sin caso: ${nombre}`); continue; }
    const caso = candidatos[0];               // el más nuevo
    const t = derivar(caso);
    if (!t) { sinTipo++; continue; }
    tipos[clave] = { paciente: nombre, case: caso.idExterno, doctora: caso.doctores?.nombre ?? null, ...t };
  }

  const resumen = new Map<string, number>();
  for (const t of Object.values(tipos)) {
    const k = `${t.audience}/${t.scope}/${t.arcades}`;
    resumen.set(k, (resumen.get(k) ?? 0) + 1);
  }
  console.log(`encontrados: ${Object.keys(tipos).length} · sin caso en Noloco: ${sinCaso} · sin tipo legible: ${sinTipo}`);
  for (const [k, v] of [...resumen].sort()) console.log(`  ${k}: ${v}`);

  if (flags.dryRun) { console.log("\nDRY-RUN (sin --apply no escribe el JSON)."); return; }
  writeFileSync(OUT, JSON.stringify({ actualizado: null, tipos }, null, 1));
  console.log(`\n✓ ${OUT}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

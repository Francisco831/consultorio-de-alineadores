/**
 * fetchAllRows — trae TODAS las filas de una consulta, paginando.
 *
 * PostgREST corta cualquier SELECT en 1.000 filas y NO devuelve error: la
 * página se renderiza con números incompletos y nadie se entera. Con 6.4k
 * doctores eso rompía los cortes por zona/categoría/owner de los reportes.
 *
 * Usar SIEMPRE que las filas se cuenten, agrupen o crucen en JS.
 * Para un total pelado es mejor `{ count: "exact", head: true }` (una sola ida).
 */
const PAGE = 1000;

export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  maxRows = 50_000
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

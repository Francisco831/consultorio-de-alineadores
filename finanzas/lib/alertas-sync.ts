// Cuándo una sincronización merece alerta.
//
// Vive fuera de lib/alertas.ts —que importa "server-only" y por eso no se puede
// ejecutar en un test— porque es la única alerta que avisa por lo que NO pasó:
// el sync no corre en un servidor sino en la Mac de Pancho, dentro de una
// sesión de Claude. Si esa sesión no corre, la app sigue mostrando los datos de
// la última vez como si fueran de hoy, y nadie se entera.

export type EstadoSync = { source: string; started_at: string; status: string };

export type AvisoSync = {
  source: string;
  severidad: "critica" | "atencion";
  titulo: string;
  detalle: string;
};

/** Cómo se llama cada sync en castellano, para que la alerta se entienda. */
export const NOMBRE_SYNC: Record<string, string> = {
  caja_ar: "Caja del consultorio",
  pagos_mx: "Pagos de México",
  blue_ambito: "Dólar blue",
  mercadopago: "Mercado Pago",
};

/** Días entre dos fechas ISO, sin horas: sólo importa el día de calendario. */
export function diasEntre(desdeISO: string, hastaISO: string): number {
  const d = Math.round(
    (Date.parse(`${hastaISO.slice(0, 10)}T00:00:00Z`) - Date.parse(`${desdeISO.slice(0, 10)}T00:00:00Z`)) / 86400000
  );
  return Math.max(0, d);
}

/** El aviso de cada fuente, a partir de su ÚLTIMA corrida. Sin corrida, no hay aviso. */
export function avisosDeSync(corridas: EstadoSync[], hoyISO: string): AvisoSync[] {
  // Las corridas vienen de más nueva a más vieja; de cada fuente vale la primera.
  const ultima = new Map<string, EstadoSync>();
  for (const c of corridas) if (!ultima.has(c.source)) ultima.set(c.source, c);

  const avisos: AvisoSync[] = [];
  for (const [src, u] of ultima) {
    const dias = diasEntre(u.started_at, hoyISO);
    const nombre = NOMBRE_SYNC[src] ?? src;
    if (u.status === "error") {
      avisos.push({
        source: src, severidad: "critica",
        titulo: `${nombre}: la última sincronización falló`,
        detalle: `Fue ${dias === 0 ? "hoy" : `hace ${dias} día(s)`}. Los datos que ves son los de antes.`,
      });
    } else if (u.status === "running" && dias >= 1) {
      // Una corrida que muere sin cerrar queda en 'running' para siempre: eso
      // es exactamente lo que fue, una corrida colgada.
      avisos.push({
        source: src, severidad: "atencion",
        titulo: `${nombre}: una sincronización quedó colgada`,
        detalle: `Arrancó hace ${dias} día(s) y nunca terminó.`,
      });
    } else if (u.status === "ok" && dias >= 3) {
      avisos.push({
        source: src, severidad: "atencion",
        titulo: `${nombre}: sin sincronizar hace ${dias} días`,
        detalle: "La app muestra lo que había la última vez que corrió.",
      });
    }
  }
  return avisos;
}

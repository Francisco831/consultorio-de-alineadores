// Vincula los comprobantes que comparte el consultorio por Drive (una carpeta
// por día "D-M-YY", adentro un archivo por paciente) con los movimientos de
// ingreso de la caja AR. El título del archivo es el nombre del paciente; la
// fecha de la carpeta, el día del pago.
import { nameScore, tokens, tokEq } from "../conciliacion/matcher";

/** true si TODOS los tokens del nombre aparecen en el título del archivo. */
function contenidoEnTitulo(nombre: string, titulo: string): boolean {
  const tt = [...tokens(titulo)];
  const tn = [...tokens(nombre)];
  return tn.length > 0 && tn.every((x) => tt.some((y) => tokEq(x, y)));
}

export type ArchivoDrive = {
  id: string;
  title: string;
  parent: string | null;
  mime: string | null;
  url: string;
  created: string | null;
};

export type CarpetaDrive = { id: string; title: string };

export type MovIngreso = {
  id: string;
  occurred_on: string;
  // display_name del counterparty si existe; si no, la descripción
  paciente: string;
  // identidad para detectar ambigüedad (counterparty_id o el nombre normalizado)
  pacienteKey: string;
};

export type Vinculo = {
  fileId: string;
  titulo: string;
  url: string;
  mime: string | null;
  fecha: string; // fecha de la carpeta
  carpeta: string;
  movementIds: string[];
  corrimiento: number; // días entre la fecha base y el movimiento (0 = mismo día)
  via: "carpeta" | "subida"; // qué fecha ancló el match
};

export type ResultadoVinculos = {
  vinculos: Vinculo[];
  sinMatch: { titulo: string; fecha: string; carpeta: string; url: string }[];
  ambiguos: { titulo: string; fecha: string; pacientes: string[] }[];
  fueraDeCarpeta: ArchivoDrive[];
};

/** "19-8-26" | "19-08-26" | "3/7/26" → ISO; null si el título no es una fecha. */
export function fechaDeCarpeta(titulo: string): string | null {
  const m = titulo.trim().match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
  if (!m) return null;
  const [, d, mes, yy] = m;
  const dia = Number(d), mm = Number(mes);
  if (dia < 1 || dia > 31 || mm < 1 || mm > 12) return null;
  return `20${yy}-${String(mm).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function vincular(
  archivos: ArchivoDrive[],
  carpetas: CarpetaDrive[],
  movimientos: MovIngreso[],
  toleranciaDias = 3
): ResultadoVinculos {
  const fechaPorCarpeta = new Map<string, { fecha: string; titulo: string }>();
  for (const c of carpetas) {
    const f = fechaDeCarpeta(c.title);
    if (f) fechaPorCarpeta.set(c.id, { fecha: f, titulo: c.title });
  }

  const porFecha = new Map<string, MovIngreso[]>();
  for (const m of movimientos) {
    const l = porFecha.get(m.occurred_on);
    if (l) l.push(m);
    else porFecha.set(m.occurred_on, [m]);
  }

  const out: ResultadoVinculos = { vinculos: [], sinMatch: [], ambiguos: [], fueraDeCarpeta: [] };

  // La caja de los últimos días todavía se está completando: un comprobante
  // reciente sin fila se colgaría del pago ANTERIOR del mismo paciente. El
  // corrimiento solo vale donde la caja ya está consolidada (carpetas de 3+
  // días antes del último día cargado); en la ventana reciente, solo mismo día.
  let maxFecha = "";
  for (const m of movimientos) if (m.occurred_on > maxFecha) maxFecha = m.occurred_on;
  const limiteConsolidado = maxFecha ? sumarDias(maxFecha, -toleranciaDias) : "";

  const buscar = (titulo: string, base: string, tolerancia: number) => {
    for (let delta = 0; delta <= tolerancia; delta++) {
      for (const signo of delta === 0 ? [0] : [-1, 1]) {
        const fecha = sumarDias(base, delta * signo);
        const matches = (porFecha.get(fecha) ?? []).filter((m) => nameScore(titulo, m.paciente) >= 0.99);
        if (matches.length) return { matches, corrimiento: delta * signo };
      }
    }
    return null;
  };

  for (const a of archivos) {
    const titulo = a.title.replace(/\.(jpe?g|pdf|png|heic)\s*$/i, "");
    const carpeta = a.parent ? fechaPorCarpeta.get(a.parent) : undefined;
    if (!carpeta) {
      out.fueraDeCarpeta.push(a);
      continue;
    }

    // mismo día primero; si no hay, el día más cercano dentro de la tolerancia
    let hit = buscar(titulo, carpeta.fecha, carpeta.fecha <= limiteConsolidado ? toleranciaDias : 0);
    let via: "carpeta" | "subida" = "carpeta";
    // algunos comprobantes se suben días después a la carpeta vieja: la fecha
    // de subida del archivo es la segunda pista
    if (!hit && a.created) {
      const subida = a.created.slice(0, 10);
      if (subida !== carpeta.fecha && subida <= maxFecha) {
        hit = buscar(titulo, subida, subida <= limiteConsolidado ? 1 : 0);
        via = "subida";
      }
    }
    const candidatos = hit?.matches ?? [];
    const corrimiento = hit?.corrimiento ?? 0;

    if (!candidatos.length) {
      out.sinMatch.push({ titulo: a.title, fecha: carpeta.fecha, carpeta: carpeta.titulo, url: a.url });
      continue;
    }

    const pacientes = new Set(candidatos.map((m) => m.pacienteKey));
    // 2+ pacientes distintos: solo es legítimo si el comprobante los nombra a
    // TODOS ("Grillo Catalina e Ignacio Etchegoyen"); si no, es un match dudoso
    if (pacientes.size > 1 && !candidatos.every((m) => contenidoEnTitulo(m.paciente, titulo))) {
      out.ambiguos.push({
        titulo: a.title,
        fecha: carpeta.fecha,
        pacientes: [...new Set(candidatos.map((m) => m.paciente))],
      });
      continue;
    }

    // un paciente: el comprobante documenta TODOS sus ingresos de ese día
    out.vinculos.push({
      fileId: a.id,
      titulo: a.title,
      url: a.url,
      mime: a.mime,
      fecha: carpeta.fecha,
      carpeta: carpeta.titulo,
      movementIds: candidatos.map((m) => m.id),
      corrimiento,
      via,
    });
  }

  return out;
}

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { crearEvento, borrarEvento } from "@/lib/actions/events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// Eventos grupales (charla, webinar, KeepDay, acreditación): cada evento se
// despliega y muestra dictante + doctores que asistieron. El intranet no
// registra esto (api/events es 1-a-1 y sin dictante), por eso vive acá.

const TIPOS = ["charla", "webinar", "keepday", "acreditacion", "otro"] as const;
const TIPO_LABEL: Record<string, string> = {
  charla: "Charla",
  webinar: "Webinar",
  keepday: "KeepDay",
  acreditacion: "Acreditación",
  otro: "Otro",
};

export default async function EventosPage() {
  const supabase = await createClient();
  const { data: eventos } = await supabase
    .from("events")
    .select(
      "id, titulo, tipo, fecha, dictante, modalidad, notas, event_attendees(id, nombre_crudo, doctor_id, doctors(nombre))"
    )
    .order("fecha", { ascending: false });

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Eventos</h1>
        <p className="text-sm text-muted-foreground">
          Charlas, webinars, KeepDays y acreditaciones — con dictante y doctores
          que asistieron
        </p>
      </div>

      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          + Registrar evento
        </summary>
        <form action={crearEvento} className="space-y-3 border-t p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Título *</label>
              <Input name="titulo" required placeholder="Ej: Charla de neuroventas CDMX" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Fecha *</label>
              <Input name="fecha" type="date" required />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Tipo</label>
              <select
                name="tipo"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                defaultValue="charla"
              >
                {TIPOS.map((t) => (
                  <option key={t} value={t}>
                    {TIPO_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Dictante</label>
              <Input name="dictante" placeholder="Quién lo dictó (Rocío, un KOL…)" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Modalidad</label>
              <select
                name="modalidad"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                defaultValue=""
              >
                <option value="">—</option>
                <option value="Presencial">Presencial</option>
                <option value="Virtual">Virtual</option>
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs text-muted-foreground">
                Asistentes — un doctor por línea (o separados por coma). Se
                vinculan solos a la ficha; si un nombre no matchea, queda igual
                como texto.
              </label>
              <textarea
                name="asistentes"
                rows={4}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                placeholder={"Sofia Flores\nLorena Ruiz\nBenjamin Navarro"}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs text-muted-foreground">Notas</label>
              <textarea
                name="notas"
                rows={2}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>
          </div>
          <Button type="submit" size="sm">
            Guardar evento
          </Button>
        </form>
      </details>

      {(eventos ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Todavía no hay eventos registrados. El primero se carga acá arriba.
        </p>
      ) : (
        <div className="space-y-2">
          {(eventos ?? []).map((e) => {
            const asistentes = (e.event_attendees ?? []) as unknown as Array<{
              id: string;
              nombre_crudo: string;
              doctor_id: string | null;
              doctors: { nombre: string } | { nombre: string }[] | null;
            }>;
            return (
              <details key={e.id} className="group rounded-lg border bg-card">
                <summary className="flex cursor-pointer select-none flex-wrap items-center gap-2 px-4 py-3">
                  <span className="text-sm font-medium">{e.titulo}</span>
                  <Badge variant="secondary">{TIPO_LABEL[e.tipo] ?? e.tipo}</Badge>
                  {e.modalidad ? (
                    <Badge variant="outline">{e.modalidad}</Badge>
                  ) : null}
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {e.fecha} · {asistentes.length}{" "}
                    {asistentes.length === 1 ? "doctor" : "doctores"}
                  </span>
                </summary>
                <div className="space-y-3 border-t px-4 py-3 text-sm">
                  <div className="grid gap-1 text-sm">
                    <p>
                      <span className="text-muted-foreground">Dictante: </span>
                      {e.dictante ?? "—"}
                    </p>
                    {e.notas ? (
                      <p className="text-muted-foreground">{e.notas}</p>
                    ) : null}
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Asistieron
                    </p>
                    {asistentes.length === 0 ? (
                      <p className="text-muted-foreground">Sin asistentes cargados.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {asistentes.map((a) =>
                          a.doctor_id ? (
                            <Link
                              key={a.id}
                              href={`/doctores/${a.doctor_id}`}
                              className="rounded-full border bg-secondary px-2.5 py-0.5 text-xs hover:bg-secondary/70"
                            >
                              {(Array.isArray(a.doctors) ? a.doctors[0]?.nombre : a.doctors?.nombre) ??
                                a.nombre_crudo}
                            </Link>
                          ) : (
                            <span
                              key={a.id}
                              title="No matcheó contra ninguna ficha"
                              className="rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground"
                            >
                              {a.nombre_crudo}
                            </span>
                          )
                        )}
                      </div>
                    )}
                  </div>
                  <form action={borrarEvento}>
                    <input type="hidden" name="id" value={e.id} />
                    <button
                      type="submit"
                      className="text-xs text-muted-foreground underline-offset-2 hover:text-red-600 hover:underline"
                    >
                      Borrar evento
                    </button>
                  </form>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

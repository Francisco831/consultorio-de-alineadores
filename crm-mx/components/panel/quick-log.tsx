"use client";

// Carga rápida del panel personal: registrar una llamada/reunión y lo
// conversado SIN pasar por la ficha del doctor. Busca doctores con la misma
// searchAll del buscador global y guarda vía logActivity (que revalida /panel).

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { logActivity } from "@/lib/actions/activities";
import { searchAll, type SearchResult } from "@/lib/actions/search";
import { ACTIVITY_TYPE_LABELS, type ActivityType } from "@/lib/types";

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** YYYY-MM-DDTHH:mm local, para el default del datetime-local */
function ahoraLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function QuickLog() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [doctor, setDoctor] = useState<{ id: string; nombre: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // typeahead con debounce; ignora respuestas viejas si se siguió tipeando.
  // El efecto solo AGENDA la búsqueda (nada de setState sincrónico acá);
  // limpiar resultados pasa en los handlers de tipeo/selección.
  useEffect(() => {
    const query = q.trim();
    if (doctor || query.length < 2) return;
    let vigente = true;
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await searchAll(query);
        if (vigente) setResults(r.filter((x) => x.kind === "doctor"));
      } finally {
        if (vigente) setBuscando(false);
      }
    }, 250);
    return () => {
      vigente = false;
      clearTimeout(t);
    };
  }, [q, doctor]);

  function submit(fd: FormData) {
    setError(null);
    setGuardado(false);
    if (!doctor) {
      setError("Elegí un doctor (buscalo por nombre).");
      return;
    }
    fd.set("doctor_id", doctor.id);
    // el server corre en UTC: convertir el datetime-local ACÁ, donde el huso
    // del navegador es el de quien registra (AR o MX), y mandar un instante ISO
    const cuando = String(fd.get("occurred_at") ?? "");
    if (cuando) fd.set("occurred_at", new Date(cuando).toISOString());
    startTransition(async () => {
      const res = await logActivity(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      formRef.current?.reset();
      setDoctor(null);
      setQ("");
      setGuardado(true);
      setTimeout(() => setGuardado(false), 4000);
    });
  }

  return (
    <form ref={formRef} action={submit} className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Doctor *</label>
        {doctor ? (
          <div className="flex h-9 items-center justify-between rounded-lg border border-input px-2.5 text-sm">
            <span className="truncate font-medium">{doctor.nombre}</span>
            <button
              type="button"
              onClick={() => setDoctor(null)}
              className="text-muted-foreground hover:text-foreground"
              title="Cambiar doctor"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="relative">
            <Input
              value={q}
              onChange={(e) => {
                const v = e.target.value;
                setQ(v);
                if (v.trim().length < 2) setResults([]);
              }}
              placeholder="Buscar por nombre…"
              autoComplete="off"
            />
            {buscando ? (
              <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
            ) : null}
            {results.length > 0 ? (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border bg-popover shadow-md">
                {results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setDoctor({ id: r.id, nombre: r.title });
                      setResults([]);
                    }}
                    className="block w-full px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <span className="font-medium">{r.title}</span>
                    {r.subtitle ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {r.subtitle}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Tipo</label>
          <select name="type" className={selectClass} defaultValue="reunion">
            {(
              Object.entries(ACTIVITY_TYPE_LABELS) as [ActivityType, string][]
            ).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Cuándo</label>
          <Input
            name="occurred_at"
            type="datetime-local"
            defaultValue={ahoraLocal()}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Qué se conversó</label>
        <Textarea
          name="summary"
          rows={3}
          placeholder="Temas, acuerdos, lo importante de la conversación…"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          Resultado / próximo paso
        </label>
        <Input name="outcome" placeholder="Ej: manda caso la semana que viene" />
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Registrar"
          )}
        </Button>
        {guardado ? (
          <span className="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" /> Guardado
          </span>
        ) : null}
      </div>
    </form>
  );
}

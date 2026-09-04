"use client";

// Cargar una viabilidad SIN entrar a la ficha del doctor. Hasta hoy el único
// camino era /doctores/[id] → Acciones rápidas → Nueva viabilidad, o sea
// entrar doctor por doctor; pedirle eso a alguien que carga diez seguidas es
// pedirle que no las cargue. El buscador es el mismo typeahead del panel
// (searchAll), así que se tipea el apellido y se sigue.

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createOpportunity } from "@/lib/actions/opportunities";
import { searchAll, type SearchResult } from "@/lib/actions/search";

/** YYYY-MM-DD de hoy en el huso de quien carga (no el del servidor). */
function hoyLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export function CargarViabilidad() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [doctor, setDoctor] = useState<{ id: string; nombre: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const pacienteRef = useRef<HTMLInputElement>(null);

  // typeahead con debounce; ignora respuestas viejas si se siguió tipeando
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
    setGuardado(null);
    if (!doctor) {
      setError("Elegí un doctor (buscalo por nombre).");
      return;
    }
    if (!String(fd.get("patient_name") ?? "").trim()) {
      setError("Falta el paciente: sin nombre no hay forma de saber después si esa viabilidad terminó en caso.");
      return;
    }
    fd.set("doctor_id", doctor.id);
    fd.set("stage", "viabilidad");
    startTransition(async () => {
      const res = await createOpportunity(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      const nombre = doctor.nombre;
      formRef.current?.reset();
      // el doctor NO se limpia: cargar varias del mismo doctor es el caso
      // normal, y volver a buscarlo cada vez es la fricción que se vino a sacar
      setGuardado(nombre);
      pacienteRef.current?.focus();
      setTimeout(() => setGuardado(null), 4000);
    });
  }

  return (
    <form
      ref={formRef}
      action={submit}
      className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] sm:items-end"
    >
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Doctor *</label>
        {doctor ? (
          <div className="flex h-9 items-center justify-between rounded-lg border border-input px-2.5 text-sm">
            <span className="truncate font-medium">{doctor.nombre}</span>
            <button
              type="button"
              onClick={() => {
                setDoctor(null);
                setQ("");
              }}
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
                      pacienteRef.current?.focus();
                    }}
                    className="block w-full px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <span className="font-medium">{r.title}</span>
                    {r.subtitle ? (
                      <span className="text-muted-foreground"> · {r.subtitle}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Paciente *</label>
        <Input
          ref={pacienteRef}
          name="patient_name"
          placeholder="Nombre y apellido"
          autoComplete="off"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Se pidió</label>
        <Input
          name="viability_requested_at"
          type="date"
          defaultValue={hoyLocal()}
          max={hoyLocal()}
          className="w-40"
        />
      </div>

      <Button type="submit" size="sm" disabled={pending} className="h-9">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cargar"}
      </Button>

      {error ? (
        <p className="text-sm text-red-600 sm:col-span-4">{error}</p>
      ) : null}
      {guardado ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-600 sm:col-span-4">
          <Check className="h-4 w-4" />
          Viabilidad cargada para {guardado}. Podés seguir con la próxima.
        </p>
      ) : null}
    </form>
  );
}

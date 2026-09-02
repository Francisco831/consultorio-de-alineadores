"use client";

// La libreta personal: se escribe, se corrige, se tacha y se borra. Componente
// autónomo — recibe las filas ya leídas por la página (/hoy la propia,
// /panel?u= la de otro).
//
// Corregir el texto lo pidió Pancho el 31/8 ("Rocío subió una nota y la quiere
// modificar"). Acá se hace en el renglón, sin diálogo: en la ficha del doctor
// una actividad es un registro y se corrige con formulario, pero un pendiente
// son dos palabras — si arreglar un typo cuesta tres clicks, nadie lo arregla.
// La base no necesitó migración: la policy de 0039 (`user_id = auth.uid()`) ya
// deja corregir solo lo propio.
//
// Dos decisiones sobre el viaje al server, que es donde una libreta se rompe
// feo: mientras la corrección viaja el renglón muestra el texto NUEVO (las
// props todavía traen el viejo, y ver reaparecer el viejo es creer que no
// guardó y corregir de nuevo); y si el server rechaza, el input queda abierto
// con lo escrito, porque eso es lo único que no está en ningún lado.
//
// `editable` es la única distinción que importa: en la libreta ajena no hay
// checkbox ni X ni formulario ni corrección, porque RLS (0039) tampoco lo
// dejaría pasar y no tiene sentido ofrecer un botón que va a fallar.
//
// El orden lo define la query de la página (order orden asc, created_at asc, que
// es el índice de 0039): acá solo se separan los tachados para mandarlos al final.

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  borrarPendiente,
  crearPendiente,
  editarPendiente,
  togglePendiente,
} from "@/lib/actions/pendientes";
import type { Pendiente } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Arriba de 3 tachados la lista empieza a tapar lo que falta hacer. */
const MAX_HECHOS_A_LA_VISTA = 3;
/** El mismo tope que el CHECK de 0039; el server también lo valida. */
const MAX_TEXTO = 500;

type Resultado = { error?: string; ok?: boolean };

export function PendientesCard({
  pendientes,
  editable,
}: {
  pendientes: Pendiente[];
  editable: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [agregado, setAgregado] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // Corrección en el renglón: un solo pendiente abierto por vez.
  const [corrigiendoId, setCorrigiendoId] = useState<string | null>(null);
  const [borrador, setBorrador] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter, Escape o el guardado ya resolvieron el renglón cuando el input recién
  // pierde el foco; sin esta marca el blur que llega después volvería a guardar
  // lo mismo.
  const resueltoRef = useRef(true);
  // espejo sincrónico de `corrigiendoId`: hace falta para saber, adentro de la
  // respuesta del server, si en el medio se abrió otro renglón
  const abiertoRef = useRef<string | null>(null);

  // Correcciones viajando al server, por id. Guarda el texto nuevo —que es lo
  // que el renglón muestra mientras dura el viaje— y también el ANTERIOR, que
  // es lo que dice cuándo soltar: mientras la lista siga trayendo el de antes,
  // el server no contestó todavía. Comparar contra el nuevo no alcanzaba: si la
  // misma persona corrige el mismo pendiente desde /hoy y desde /panel a la vez,
  // gana uno de los dos y el otro renglón se quedaba con el relojito girando
  // para siempre, mostrando un texto que ya no era el de nadie.
  //
  // El relojito va EN ESE renglón: el spinner del botón "Agregar" queda abajo de
  // todo, sin relación con lo que la persona acaba de tocar, así que la
  // corrección va en su propia transición.
  const [enVuelo, setEnVuelo] = useState<
    Record<string, { nuevo: string; anterior: string }>
  >({});
  const [, startCorreccion] = useTransition();

  const abiertos = pendientes.filter((p) => !p.hecho);
  const hechos = pendientes.filter((p) => p.hecho);
  const colapsar = hechos.length > MAX_HECHOS_A_LA_VISTA;
  // los tachados van al final; si son muchos se guardan en el <details>
  const visibles = colapsar ? abiertos : [...abiertos, ...hechos];

  // Al abrir: foco puesto y cursor al final, para seguir escribiendo donde
  // quedó en vez de tener que buscar el punto con el mouse.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [corrigiendoId]);

  function enviar(
    action: (fd: FormData) => Promise<Resultado>,
    fd: FormData
  ) {
    setError(null);
    setAgregado(false);
    startTransition(async () => {
      const res = await action(fd);
      if (res?.error) setError(res.error);
    });
  }

  function alta(fd: FormData) {
    setError(null);
    setAgregado(false);
    startTransition(async () => {
      const res = await crearPendiente(fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      formRef.current?.reset();
      setAgregado(true);
      setTimeout(() => setAgregado(false), 3000);
    });
  }

  /** `texto` es lo que se está viendo en el renglón, que con una corrección en
   *  vuelo no es todavía lo que traen las props. */
  function abrirCorreccion(id: string, texto: string) {
    setError(null);
    resueltoRef.current = false;
    setBorrador(texto);
    abiertoRef.current = id;
    setCorrigiendoId(id);
  }

  function cerrarCorreccion() {
    resueltoRef.current = true;
    abiertoRef.current = null;
    setCorrigiendoId(null);
  }

  function guardarCorreccion(id: string, textoActual: string) {
    if (resueltoRef.current) return;
    // el renglón queda resuelto acá mismo: el blur que llega detrás de Enter no
    // tiene que mandar la misma corrección dos veces
    resueltoRef.current = true;

    const texto = borrador.trim();
    // si no cambió nada no se molesta al server: salir sin tocar es lo más
    // común (uno abre, mira, y sigue)
    if (texto === textoActual) {
      cerrarCorreccion();
      return;
    }

    const fd = new FormData();
    fd.set("id", id);
    fd.set("texto", texto);

    setError(null);
    setAgregado(false);
    setEnVuelo((actual) => {
      // de paso se sueltan las correcciones que el server ya contestó: el
      // renglón las ignora igual, pero sin esta barrida las claves viejas se
      // quedarían para siempre en el mapa
      const limpio: typeof actual = {};
      for (const [otro, viaje] of Object.entries(actual)) {
        if (pendientes.some((p) => p.id === otro && p.texto === viaje.anterior)) {
          limpio[otro] = viaje;
        }
      }
      limpio[id] = { nuevo: texto, anterior: textoActual };
      return limpio;
    });

    startCorreccion(async () => {
      const res = await editarPendiente(fd);
      if (res?.error) {
        // El renglón NO se cierra con un error (sesión vencida, pendiente de
        // otro, red): si se cerrara, lo escrito no quedaría en ningún lado y
        // habría que tipearlo de nuevo. Vuelve el texto viejo a la lista y el
        // input queda abierto con la corrección, lista para reintentar.
        setEnVuelo((actual) => {
          const resto = { ...actual };
          delete resto[id];
          return resto;
        });
        setError(res.error);
        // …salvo que en el viaje se haya abierto OTRO renglón: ahí la persona ya
        // está escribiendo en otra cosa, y saltarle el foco de vuelta le borra
        // lo que está tipeando. El error igual se ve al pie de la libreta.
        if (abiertoRef.current === null || abiertoRef.current === id) {
          abiertoRef.current = id;
          setCorrigiendoId(id);
          setBorrador(texto);
          resueltoRef.current = false;
        }
        return;
      }
      // Recién con el OK del server se cierra el renglón — y solo si sigue
      // siendo el que está abierto, porque en el medio se pudo haber abierto
      // otro. El texto nuevo lo sigue mostrando `enVuelo` hasta que la lista
      // vuelva con él.
      if (abiertoRef.current === id) abiertoRef.current = null;
      setCorrigiendoId((abierto) => (abierto === id ? null : abierto));
    });
  }

  function renglon(p: Pendiente) {
    // La corrección está "en vuelo" mientras la lista siga trayendo el texto de
    // ANTES; en cuanto trae cualquier otra cosa, el server ya contestó y manda
    // la lista. Se deriva acá, en el render, en vez de limpiar el mapa desde un
    // efecto: soltar el texto nuevo apenas contesta el server haría parpadear el
    // viejo justo cuando uno mira si guardó.
    const enviando = enVuelo[p.id];
    const guardando = enviando !== undefined && p.texto === enviando.anterior;
    const texto = guardando ? enviando.nuevo : p.texto;
    const corrigiendo = editable && corrigiendoId === p.id;

    return (
      <li key={p.id} className="group flex items-center gap-2 px-3 py-2">
        {editable ? (
          <form action={(fd) => enviar(togglePendiente, fd)}>
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="hecho" value={p.hecho ? "false" : "true"} />
            <Button
              type="submit"
              size="icon-xs"
              variant="ghost"
              title={p.hecho ? "Destachar" : "Tachar"}
            >
              {p.hecho ? (
                <Check className="text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Square className="text-muted-foreground" />
              )}
            </Button>
          </form>
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center">
            {p.hecho ? (
              <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Square className="size-3 text-muted-foreground" />
            )}
          </span>
        )}

        {corrigiendo ? (
          <>
            <Input
              ref={inputRef}
              value={borrador}
              onChange={(e) => setBorrador(e.target.value)}
              onKeyDown={(e) => {
                // con la corrección en vuelo no hay nada que confirmar ni que
                // cancelar: el server ya la tiene
                if (guardando) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  guardarCorreccion(p.id, texto);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cerrarCorreccion();
                }
              }}
              // guardar al salir del renglón: en una libreta uno corrige y sigue
              // con otra cosa, no busca un botón de confirmar
              onBlur={() => guardarCorreccion(p.id, texto)}
              // mientras viaja se puede leer pero no tocar: si siguiera
              // escribiendo, el OK cerraría el input encima de lo nuevo
              readOnly={guardando}
              maxLength={MAX_TEXTO}
              autoComplete="off"
              aria-label="Corregir el pendiente"
              aria-busy={guardando}
              className="h-7 min-w-0 flex-1"
            />
            {borrador.length > MAX_TEXTO - 200 ? (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {MAX_TEXTO - borrador.length} caracteres
              </span>
            ) : null}
          </>
        ) : editable && !guardando ? (
          <button
            type="button"
            onClick={() => abrirCorreccion(p.id, texto)}
            title="Corregir"
            className={cn(
              "min-w-0 flex-1 cursor-text rounded-sm px-1 py-0.5 text-left text-sm wrap-anywhere outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
              // un pendiente ya tachado también se corrige: corregir el texto no
              // lo destacha (el trigger de 0039 solo mira `hecho`)
              p.hecho && "line-through opacity-60"
            )}
          >
            {texto}
          </button>
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 text-sm wrap-anywhere",
              p.hecho && "line-through opacity-60"
            )}
          >
            {texto}
          </span>
        )}

        {/* El relojito va acá, en el renglón que se está corrigiendo, y ocupa el
            mismo lugar que la X para que la lista no se mueva. Mientras se
            corrige la X se esconde: el click sobre ella cerraría el input
            primero, y un borrado a medio camino de una corrección es lo último
            que uno quiere en su propia libreta */}
        {guardando ? (
          <span
            title="Guardando la corrección"
            className="flex size-6 shrink-0 items-center justify-center"
          >
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          </span>
        ) : editable && !corrigiendo ? (
          <form action={(fd) => enviar(borrarPendiente, fd)}>
            <input type="hidden" name="id" value={p.id} />
            <Button
              type="submit"
              size="icon-xs"
              variant="ghost"
              title="Borrar"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X />
            </Button>
          </form>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-3">
      {pendientes.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {editable
            ? "Sin pendientes. Anotá lo que tengas que hacer hoy."
            : "Sin pendientes anotados."}
        </p>
      ) : null}

      {visibles.length > 0 ? (
        <ul className="divide-y rounded-lg border">{visibles.map(renglon)}</ul>
      ) : null}

      {colapsar ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Hechos · {hechos.length}
          </summary>
          <ul className="mt-2 divide-y rounded-lg border">
            {hechos.map(renglon)}
          </ul>
        </details>
      ) : null}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {editable ? (
        <form ref={formRef} action={alta} className="flex items-center gap-2">
          <Input
            name="texto"
            placeholder="Anotá un pendiente…"
            autoComplete="off"
            maxLength={MAX_TEXTO}
            aria-label="Nuevo pendiente"
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <>
                <Plus data-icon="inline-start" />
                Agregar
              </>
            )}
          </Button>
          {agregado ? (
            <span className="flex shrink-0 items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="h-4 w-4" /> Anotado
            </span>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

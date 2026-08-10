// Cola de clasificación del sujeto del caso (¿de quién es este tratamiento?).
//
// El orden lo da case_self_similarity(): un caso cuyo paciente se llama igual
// que el doctor es CANDIDATO a ser su caso propio. El parecido prioriza la
// revisión y nada más — quien clasifica es la persona, siempre.
//
// Server Component: los botones son submits de un <form> con server action,
// sin JavaScript de cliente.

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { classifyCaseSubject } from "@/lib/actions/quality";
import { formatDate, formatEtapa } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Fila que devuelve el RPC case_subject_review_queue (migración 0024). */
export interface CaseReviewRow {
  case_id: string;
  doctor_id: string;
  doctor_nombre: string | null;
  paciente: string | null;
  case_label: string | null;
  etapa: string | null;
  fecha_ingreso: string;
  is_new_case: boolean;
  similarity: number | null;
}

const OPTIONS: { value: string; label: string; title: string }[] = [
  {
    value: "PATIENT",
    label: "Paciente",
    title: "El tratamiento es de un paciente del doctor",
  },
  {
    value: "DOCTOR_SELF",
    label: "Caso propio",
    title: "El doctor se trató a sí mismo (el hito de confianza previo al primer paciente)",
  },
  {
    value: "OTHER",
    label: "Otro",
    title: "Familiar, equipo de la clínica, demo u otro",
  },
  {
    value: "UNKNOWN",
    label: "No se puede saber",
    title: "Queda registrado que se revisó y no hay forma de saberlo",
  },
];

function similarityNote(sim: number | null): string | null {
  if (sim == null) return null;
  const p = Math.round(sim * 100);
  if (p >= 80) return `Se llama casi igual que el doctor (${p}%)`;
  if (p >= 50) return `Nombre parecido al del doctor (${p}%)`;
  return null;
}

export function CaseSubjectReview({
  rows,
  pending,
}: {
  rows: CaseReviewRow[];
  pending: number | null;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No queda ningún caso sin clasificar.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {pending != null ? `${pending.toLocaleString("es-MX")} casos sin clasificar` : "Pendientes sin medir"}
        {" · "}
        mostrando {rows.length}, los más parecidos al nombre del doctor primero.
        El parecido solo ordena la cola: no clasifica nada.
      </p>
      <ul className="divide-y rounded-lg border">
        {rows.map((r) => {
          const note = similarityNote(r.similarity);
          return (
            <li
              key={r.case_id}
              className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Link
                    href={`/doctores/${r.doctor_id}`}
                    className="font-medium hover:underline"
                  >
                    {r.doctor_nombre ?? "Doctor sin nombre"}
                  </Link>
                  <span className="text-muted-foreground">
                    Caso {r.case_label ?? "—"}
                  </span>
                  {r.is_new_case ? (
                    <span className="rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400">
                      1ª etapa
                    </span>
                  ) : null}
                  {note ? (
                    <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {note}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Paciente: {r.paciente ?? "sin nombre cargado"} ·{" "}
                  {formatEtapa(r.etapa)} · ingresó {formatDate(r.fecha_ingreso)}
                </p>
              </div>

              <form action={classifyCaseSubject} className="flex flex-wrap gap-1.5">
                <input type="hidden" name="case_id" value={r.case_id} />
                {OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="submit"
                    name="case_subject_type"
                    value={o.value}
                    title={o.title}
                    className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
                  >
                    {o.label}
                  </button>
                ))}
              </form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

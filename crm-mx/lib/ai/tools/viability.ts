// Tools de VIABILIDAD (migración 0022: ciclo de viabilidad sobre opportunities).
//
// Regla maestra del Brain: se puede afirmar la generalidad ("aproximadamente el
// 90% de los casos se resuelven con alineadores"), NUNCA que ESTE caso se puede
// resolver. Ante cualquier pregunta sobre un caso concreto la única respuesta
// autorizada es pedir una viabilidad: la evalúa el equipo clínico, no la IA.
//
// requestViabilityDraft NO escribe nada: devuelve el borrador del pedido (y un
// payload de tarea ejecutable por el flujo HITL existente). El registro real del
// ciclo (viability_requested_at / viability_status / owner clínico) lo hace un
// humano con su sesión.

import { z } from "zod";
import { createAiReadClient } from "@/lib/ai/read-client";
import { toStrictJsonSchema } from "@/lib/ai/schemas";
import { todayMX } from "@/lib/dates";
import { daysSince } from "@/lib/format";
import type { AiToolDef, AiToolResult } from "@/lib/ai/types";
import { refOportunidad } from "@/lib/ai/pii";

const MAX_ROWS = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Estados del ciclo que siguen esperando respuesta del equipo clínico. */
const ESTADOS_ABIERTOS = new Set(["solicitada", "enviada"]);
const ETAPAS_CERRADAS = new Set(["ganada", "perdida"]);

/** Lo único que se puede afirmar sin equipo clínico de por medio. */
export const REGLA_90 =
  "aproximadamente el 90% de los casos se resuelven con alineadores";

const NO_JUZGAR_EL_CASO =
  `Podés afirmar la regla general ("${REGLA_90}"), que es una afirmación sobre la técnica. PROHIBIDO opinar sobre ESTE caso: no digas que es viable, tratable, sencillo, complejo, que "seguro se puede" ni que "probablemente no". La respuesta autorizada es ofrecer/pedir la viabilidad y dejar que la responda el equipo clínico.`;

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.output<S>) => Promise<AiToolResult>;
}): AiToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: toStrictJsonSchema(def.schema),
    handler: async (args) => def.handler(def.schema.parse(args)),
  };
}

function bail(message: string): never {
  throw new Error(message);
}

const doctorIdArg = z.string().describe("id (uuid) del doctor en el CRM");

interface OppRow {
  id: string;
  stage: string;
  stage_entered_at: string;
  created_at: string;
  viability_requested_at: string | null;
  viability_submitted_at: string | null;
  viability_status: string | null;
  viability_result: string | null;
  viability_completed_at: string | null;
  viability_clinical_owner: string | null;
  viability_follow_up_date: string | null;
}

// Sin `patient_name`: lo que devuelve una tool va entero al modelo. Ver lib/ai/pii.ts.
const OPP_COLS =
  "id, stage, stage_entered_at, created_at, viability_requested_at, viability_submitted_at, viability_status, viability_result, viability_completed_at, viability_clinical_owner, viability_follow_up_date";

const d10 = (iso: string | null): string | null => iso?.slice(0, 10) ?? null;

export const getViabilityStatus = defineTool({
  name: "getViabilityStatus",
  description:
    "Estado del ciclo de viabilidad del doctor: viabilidades abiertas (solicitadas o enviadas, y oportunidades en etapa 'viabilidad'), con desde cuándo esperan, la respuesta del equipo clínico cuando ya la hay y la fecha de seguimiento. Usala ANTES de proponer cualquier acción clínica o de ofrecer una viabilidad nueva: si ya hay una esperando respuesta, la acción es hacer seguimiento, no pedir otra. Una oportunidad sin ciclo registrado es DATO FALTANTE, no evidencia de que no se pidió.",
  schema: z.strictObject({ doctor_id: doctorIdArg }),
  handler: async ({ doctor_id }) => {
    if (!UUID_RE.test(doctor_id)) bail("doctor_id inválido: se espera un uuid");
    const supabase = await createAiReadClient();
    const today = todayMX();

    const [{ data: oppsRaw, error }, { data: profilesRaw }] = await Promise.all([
      supabase
        .from("opportunities")
        .select(OPP_COLS)
        .eq("doctor_id", doctor_id)
        .eq("is_demo", false)
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS),
      supabase.from("profiles").select("id, nombre"),
    ]);
    if (error) bail(`Error leyendo el ciclo de viabilidad: ${error.message}`);

    const names = new Map(
      ((profilesRaw ?? []) as { id: string; nombre: string }[]).map((p) => [p.id, p.nombre])
    );
    const opps = (oppsRaw ?? []) as unknown as OppRow[];

    const esAbierta = (o: OppRow) =>
      (o.viability_status != null && ESTADOS_ABIERTOS.has(o.viability_status)) ||
      (o.stage === "viabilidad" && !ETAPAS_CERRADAS.has(o.stage));
    const tieneCiclo = (o: OppRow) =>
      o.viability_status != null ||
      o.viability_requested_at != null ||
      o.viability_result != null;

    const map = (o: OppRow) => ({
      opportunity_id: o.id,
      // Referencia, no nombre: lo que vuelve de una tool va entero al modelo
      // (runner.ts serializa `res.data`). Ver lib/ai/pii.ts.
      ref: refOportunidad(o.id),
      etapa_oportunidad: o.stage,
      dias_en_etapa: daysSince(o.stage_entered_at),
      estado_viabilidad: o.viability_status ?? "sin registro del ciclo de viabilidad",
      solicitada: d10(o.viability_requested_at),
      dias_desde_solicitud: daysSince(o.viability_requested_at),
      enviada: d10(o.viability_submitted_at),
      respondida: d10(o.viability_completed_at),
      // texto del equipo clínico tal cual (ej. "Medium", "Medium y adicional")
      resultado_clinico: o.viability_result,
      seguimiento: o.viability_follow_up_date,
      seguimiento_vencido:
        o.viability_follow_up_date != null && o.viability_follow_up_date < today,
      responsable_clinico: o.viability_clinical_owner
        ? (names.get(o.viability_clinical_owner) ?? null)
        : null,
    });

    const abiertas = opps.filter(esAbierta);
    const resueltas = opps
      .filter((o) => !esAbierta(o) && tieneCiclo(o))
      .slice(0, 10);
    const sinCicloRegistrado = opps.filter(
      (o) => o.stage === "viabilidad" && !tieneCiclo(o)
    ).length;

    return {
      data: {
        doctor_id,
        consultado_al: today,
        viabilidades_abiertas: abiertas.map(map),
        viabilidades_resueltas: resueltas.map(map),
        oportunidades_en_etapa_viabilidad_sin_ciclo_registrado: sinCicloRegistrado,
        nota_de_datos:
          "Una oportunidad en etapa 'viabilidad' sin viability_status NO permite afirmar que la viabilidad se pidió, se envió o quedó sin respuesta: es dato faltante. Decilo como 'sin registro del ciclo de viabilidad'.",
        instruccion: `El resultado_clinico es la respuesta textual del equipo clínico: citalo tal cual, no lo interpretes ni lo extiendas a otro caso. ${NO_JUZGAR_EL_CASO}`,
      },
      rows: abiertas.length + resueltas.length,
    };
  },
});

export const requestViabilityDraft = defineTool({
  name: "requestViabilityDraft",
  description:
    "Arma el BORRADOR del pedido de viabilidad al equipo clínico. NO escribe nada. Es la respuesta AUTORIZADA cada vez que el doctor pregunta si un caso concreto se puede tratar con alineadores: la IA no juzga el caso — se ofrece mandar la viabilidad y se registra el pedido. Devuelve el draft del pedido, el payload de tarea (kind 'task') para incluir en la recomendación y los campos que un humano debe registrar en la oportunidad al mandarla. Antes de usarla, revisa getViabilityStatus: si ya hay una viabilidad esperando respuesta, corresponde seguimiento, no un pedido nuevo.",
  schema: z.strictObject({
    doctor_id: doctorIdArg,
    motivo_clinico: z
      .string()
      .describe(
        "la duda clínica concreta tal como la planteó el doctor, o el motivo del pedido. Sin interpretación ni pronóstico"
      ),
    // Se quitó el argumento `paciente`. El modelo ya no recibe nombres de paciente,
    // así que pedírselos solo podía producir uno inventado. La viabilidad se cuelga
    // de `opportunity_id`, que es el vínculo real; la interfaz muestra el paciente.
    opportunity_id: z
      .string()
      .nullish()
      .describe("uuid de la oportunidad ya existente a la que corresponde la viabilidad, si la hay"),
    fecha_seguimiento: z
      .string()
      .nullish()
      .describe(
        "fecha de seguimiento YYYY-MM-DD si el equipo la definió; omitir si no hay fecha acordada (el SLA de respuesta clínica NO está definido: no inventes una)"
      ),
  }),
  handler: async ({ doctor_id, motivo_clinico, opportunity_id, fecha_seguimiento }) => {
    if (!UUID_RE.test(doctor_id)) bail("doctor_id inválido: se espera un uuid");
    const motivo = motivo_clinico.trim();
    if (!motivo) bail("motivo_clinico no puede estar vacío");
    if (fecha_seguimiento != null && !DATE_RE.test(fecha_seguimiento))
      bail("fecha_seguimiento debe ser YYYY-MM-DD o null");
    if (opportunity_id != null && !UUID_RE.test(opportunity_id))
      bail("opportunity_id inválido: se espera un uuid");

    const supabase = await createAiReadClient();
    const { data: doctorRaw, error } = await supabase
      .from("doctors")
      .select("id, nombre, clinical_owner_id")
      .eq("id", doctor_id)
      .maybeSingle();
    if (error) bail(`Error leyendo el doctor: ${error.message}`);
    if (!doctorRaw) bail(`Doctor ${doctor_id} no encontrado: no se arma el borrador`);
    const doctor = doctorRaw as {
      id: string;
      nombre: string;
      clinical_owner_id: string | null;
    };

    // La viabilidad se cuelga de una oportunidad real: si el modelo pasa un id,
    // se verifica que exista y sea de ESTE doctor (si no, el pedido quedaría
    // registrado sobre el paciente de otro).
    let oportunidad: { id: string; etapa: string } | null = null;
    if (opportunity_id) {
      const { data: oppRaw, error: oppErr } = await supabase
        .from("opportunities")
        .select("id, doctor_id, stage")
        .eq("id", opportunity_id)
        .maybeSingle();
      if (oppErr) bail(`Error leyendo la oportunidad: ${oppErr.message}`);
      if (!oppRaw) bail(`Oportunidad ${opportunity_id} no encontrada`);
      const opp = oppRaw as { id: string; doctor_id: string; stage: string };
      if (opp.doctor_id !== doctor_id)
        bail("La oportunidad indicada es de otro doctor: no se arma el borrador");
      oportunidad = { id: opp.id, etapa: opp.stage };
    }

    // El título lleva la referencia, no el nombre. La tarea guarda `opportunity_id`,
    // así que la pantalla muestra de qué paciente se trata cuando Rocío la abre.
    const pacienteRef = oportunidad ? refOportunidad(oportunidad.id) : null;
    const titulo = `Pedir viabilidad al equipo clínico${pacienteRef ? ` — ${pacienteRef}` : ""}`;

    return {
      data: {
        draft: {
          kind: "viability_request" as const,
          doctor_id: doctor.id,
          doctor: doctor.nombre,
          paciente: pacienteRef,
          opportunity_id: oportunidad?.id ?? null,
          motivo_clinico: motivo,
          fecha_seguimiento: fecha_seguimiento ?? null,
        },
        // Ejecutable por el flujo HITL existente (kind 'task' → crea la tarea con
        // la sesión del usuario cuando acepta). El ciclo de viabilidad en la
        // oportunidad lo registra el humano: la IA no lo escribe.
        payload: {
          kind: "task" as const,
          title: titulo,
          type: "revision_clinica" as const,
          due_date: fecha_seguimiento ?? null,
          description: `${motivo}${pacienteRef ? ` · Paciente: ${pacienteRef}` : ""}${
            oportunidad ? ` · Oportunidad ${oportunidad.id} (etapa ${oportunidad.etapa})` : ""
          } · Al mandarla, registrar en la oportunidad: viability_requested_at, viability_status='solicitada', viability_clinical_owner y viability_follow_up_date.`,
        },
        a_registrar_por_un_humano: [
          "opportunities.viability_requested_at (cuándo se pidió)",
          "opportunities.viability_status = 'solicitada'",
          "opportunities.viability_clinical_owner (quién del equipo clínico la toma)",
          "opportunities.viability_follow_up_date (cuándo volver, si se acordó)",
        ],
        responsable_clinico_actual: doctor.clinical_owner_id ? "asignado" : "sin asignar",
        respuesta_autorizada: NO_JUZGAR_EL_CASO,
        guia_de_mensaje:
          "Si redactás el mensaje al doctor (createMessageDraft): trato de usted, ofrecer mandar la viabilidad, pedir los registros que el equipo clínico necesite y cerrar con próximo paso. NO prometas plazo de respuesta (no está definido) ni adelantes el resultado.",
        instrucciones:
          "Borrador validado. NO se escribió nada: incluir `payload` tal cual en el campo `payload` de la recomendación emitida (emit). La tarea se crea recién si el usuario acepta.",
      },
      rows: null,
    };
  },
});

export const VIABILITY_TOOLS: AiToolDef[] = [getViabilityStatus, requestViabilityDraft];

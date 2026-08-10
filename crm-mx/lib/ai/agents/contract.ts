// Contrato de ESPECIALISTA (Fase 3).
//
// El problema que resuelve: nueve prompts escritos a mano terminan diciendo casi
// lo mismo con nombres distintos, y peor, se desincronizan de lo que el sistema
// declara que cada agente hace.
//
// Acá cada agente se DECLARA como una estructura —universo, misión, KPI, señales
// que lee, hipótesis que puede formular, acciones que puede y que NO puede
// recomendar, handoffs, cómo prioriza su cartera— y el system prompt se COMPONE
// a partir de esa declaración. Una sola fuente: si cambia el contrato, cambia el
// prompt, y los tests verifican el contrato, no un texto suelto.
//
// El Brain es común a todos (lib/ai/brain); esto es la PERSPECTIVA desde la que
// cada agente lo mira.

import type {
  AgentKey,
  Bottleneck,
  OwnerRole,
  RecommendationChannel,
} from "@/lib/ai/types";
import type { BrainSectionKey } from "@/lib/ai/brain";

/** Un handoff declarado: a quién le pasa el doctor y con qué condición. */
export interface HandoffRule {
  hacia: AgentKey;
  cuando: string;
}

export interface AgentSpec {
  key: AgentKey;
  nombre: string;
  /** Una línea, para chips y logs. */
  objetivo: string;

  // --- contrato de especialista ---
  /** A qué doctores mira este agente y a cuáles NO. */
  universo: string;
  /** Qué logra. No "qué hace": qué cambia en la relación con el doctor. */
  mision: string;
  kpi_primario: string;
  kpi_secundarios: string[];
  /** Los cuellos de botella que este agente está capacitado para atacar. */
  bottlenecks: Bottleneck[];
  /** Qué lee del contexto — su lente. */
  senales: string[];
  /** Qué puede inferir (siempre marcado como inferencia, nunca como hecho). */
  hipotesis: string[];
  acciones_permitidas: string[];
  acciones_prohibidas: string[];
  handoffs: HandoffRule[];
  /** Cómo ordena su propia cartera cuando hay varios doctores compitiendo. */
  priorizacion: string[];
  /** Quiénes suelen ejecutar sus acciones. */
  owners_habituales: OwnerRole[];
  canales_habituales: RecommendationChannel[];

  // --- composición del prompt ---
  brainSections: BrainSectionKey[];
  /** Párrafos propios del agente: lo que no se deduce de los campos de arriba
   *  (matices, vocabulario obligatorio, trampas conocidas). */
  notas: string[];
}

// ---------------------------------------------------------------------------
// Composición del system prompt
// ---------------------------------------------------------------------------

const OWNER_ES: Record<OwnerRole, string> = {
  SALES: "comercial",
  CLINICAL: "equipo clínico",
  COUNTRY_MANAGER: "dirección de país",
  OPERATIONS: "operaciones",
  ADMIN: "administración",
  MARKETING: "marketing",
};

const CANAL_ES: Record<RecommendationChannel, string> = {
  whatsapp: "WhatsApp",
  call: "llamada",
  video: "videollamada",
  visit: "visita",
  clinical: "revisión clínica",
  task: "tarea interna",
};

const AGENTE_ES: Record<AgentKey, string> = {
  orchestrator: "el orquestador",
  acquisition: "Adquisición",
  accreditation: "Acreditación",
  activation: "Activación",
  clinical_education: "Clínica y Educación",
  growth: "Growth",
  retention_reactivation: "Retención y Reactivación",
  doctor_success: "Éxito del Doctor (servicio)",
  commercial_director: "Dirección Comercial",
};

function lista(items: readonly string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}

/**
 * Bloque común a todos: cómo se emite, qué se puede y qué no. Es el ÚNICO texto
 * compartido — todo lo demás sale del contrato del agente.
 */
const REGLAS_SALIDA = `## Cómo trabajas

1. La pregunta que gobierna todo: **¿QUÉ IMPIDE QUE ESTE DOCTOR PASE AL SIGUIENTE ESTADO SANO DE LA RELACIÓN CON KEEPSMILING?** Identifica ese cuello de botella y atácalo. No maximices actividad, ni mensajes, ni descuentos, ni casos de corto plazo.
2. Analiza el contexto recibido. Usa tus tools SOLO si te falta un dato puntual — no vuelvas a consultar lo que ya tienes.
3. Emites 1 a 3 recomendaciones llamando UNA sola vez la tool \`emit\`. Nada de texto suelto como resultado.

## Qué responde cada recomendación

Seis cosas, sin excepción: QUÉ hacemos · POR QUÉ · POR QUÉ AHORA · QUIÉN lo hace · POR QUÉ CANAL · QUÉ RESULTADO buscamos. "Hacer seguimiento" no es una recomendación.

Además declaras:
- \`bottleneck\`: el cuello de botella que estás atacando, del vocabulario del sistema.
- \`owner_role\`: quién ejecuta. No todo es del comercial — una duda clínica es del equipo clínico, un caso trabado es de operaciones, una relación grande en riesgo es de dirección.
- \`current_stage\`: en qué punto de la relación está, en palabras del negocio.
- \`expected_outcome\`: qué queremos que pase como consecuencia (el resultado, no la acción).
- \`follow_up_condition\`: qué gatilla el siguiente paso.
- \`recommended_date\`: fecha concreta. Una acción sin fecha no se ejecuta.

## Evidencia primero

- \`evidence\`: SOLO hechos con campo y valor tomados del contexto. Cita la frescura ("datos al {fecha}") y baja tu \`confidence\` si tienen más de 7 días.
- \`why\`: tu razonamiento. Toda inferencia va marcada como inferencia ("infiero que…"). PROHIBIDO presentar una inferencia como dato.
- Si un dato no está, la respuesta correcta es decir que no se sabe. Nunca rellenar el hueco.
- Lo que el contexto marca como estimado, POSSIBLE o "dato dudoso" NO se presenta como hecho.
- Un hito DESCONOCIDO no se afirma ni se niega.

## Idioma y registro

- \`suggested_message\` va en español de MÉXICO, trato de USTED, "Doctor/Doctora". Cero voseo argentino (vos, tenés, querés, mandame, decime, dale).
- Estructura de un mensaje comercial: CONTEXTO + MOTIVO DEL CONTACTO + VALOR + SIGUIENTE PASO SIN PRESIÓN. Corto para WhatsApp.
- Las etiquetas internas (riesgo de churn, cuenta dormida, engagement bajo, score, brecha de crecimiento) JAMÁS aparecen en un mensaje al doctor.
- Es un borrador: nunca se envía solo. \`requires_user_confirmation\` = true SIEMPRE.

## Acciones de sistema: no son de todos, son del cuello de botella

Dos recomendaciones sirven para casi cualquier doctor y por eso las podrían emitir los nueve agentes: **proponer que se asigne un dueño** (comercial o clínico) y **proponer que se clasifique un dato** (el tipo de caso, la calidad de una interacción). Si cada agente las emite cuando quiere, el doctor recibe nueve veces lo mismo y el sistema deja de ser especialista.

La regla de desempate es el cuello de botella que declaró el ruteo, y viene en tu contexto:
- **SIN_DUENO** → la asignación de dueño es la recomendación principal. Emítela.
- **DATOS_INSUFICIENTES** → la clasificación del dato es la recomendación principal. Emítela.
- **Cualquier otro cuello** → esas dos acciones NO son tuyas en esta corrida. Trabaja tu especialidad y, si la falta de dueño o de dato te limita, dilo en \`why\` y bájate la \`confidence\` — pero no conviertas eso en la recomendación.

## Dos respuestas que también son correctas

- **No contactar hoy**, si no hay información nueva ni nada que aportar.
- **Que intervenga una persona** (equipo clínico, dirección, operaciones) en lugar de una acción automatizable.`;

export function buildSystemPrompt(spec: AgentSpec): string {
  const handoffs =
    spec.handoffs.length > 0
      ? spec.handoffs.map((h) => `- Hacia ${AGENTE_ES[h.hacia]}: ${h.cuando}`).join("\n")
      : "- No derivas a otro agente: eres el destino final de tu tipo de problema.";

  return `Eres el agente de ${spec.nombre.toUpperCase()} del sistema comercial AI de KeepSmiling México. Eres un ESPECIALISTA: miras el negocio desde una perspectiva propia y no haces el trabajo de los demás agentes.

## Tu universo
${spec.universo}

## Tu misión
${spec.mision}

## Cómo se te mide
- KPI primario: ${spec.kpi_primario}
${spec.kpi_secundarios.map((k) => `- KPI secundario: ${k}`).join("\n")}

## Los cuellos de botella que atacas
${spec.bottlenecks.join(" · ")}

## Qué miras del contexto
${lista(spec.senales)}

## Qué puedes inferir
Estas son HIPÓTESIS, no hechos. Van marcadas como inferencia y con su evidencia parcial al lado:
${lista(spec.hipotesis)}

## Qué puedes recomendar
${lista(spec.acciones_permitidas)}

## Qué NO puedes recomendar
${lista(spec.acciones_prohibidas)}

## Cuándo sueltas el doctor
${handoffs}

## Cómo priorizas tu cartera
${lista(spec.priorizacion)}

## Quién ejecuta y por dónde
- Owners habituales: ${spec.owners_habituales.map((o) => OWNER_ES[o]).join(", ")}.
- Canales habituales: ${spec.canales_habituales.map((c) => CANAL_ES[c]).join(", ")}. Elige el canal por el objetivo, no por comodidad: no todo es WhatsApp.
${spec.notas.length > 0 ? `\n## Específico de tu especialidad\n${spec.notas.map((n) => `\n${n}`).join("\n")}` : ""}

${REGLAS_SALIDA}`;
}

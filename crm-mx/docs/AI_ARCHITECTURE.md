# CRM MX — AI-Native Multi-Agent Commercial Operating System

Versión: 2026.08 · Fecha: 8/8/2026 · Estado: diseño aprobado + implementación V1

Principio rector: **¿Qué necesita este doctor para avanzar con confianza?** y recién después
**¿cuál es la mejor acción comercial para ayudarlo a avanzar?** Servicio/confianza > growth.

---

## 1. Auditoría de la arquitectura actual (relevante para agentes)

Lo que YA existe y la capa de agentes debe respetar (no reconstruir):

**Datos (Supabase, 16 migraciones, 21 tablas):**
- `doctors` es el hub: 6.416 filas reales. Modelo de **dos universos** (0015): `is_accredited`
  corta universo A (prospección, `acquisition_stage`, 10 etapas) de universo B (generación de
  casos, `activation_stage` + máquina de lifecycle de 16 estados). Solo ~208 acreditados.
- **Motor determinístico ya ocupa el nicho**: `recompute_doctor()` v3 (0016) calcula
  `health_score`, `potential_computed`, `priority_score`, `priority_reasons` ({code,text,weight}),
  `priority_bucket` (8 buckets) y `recommended_action` ({type,label}). Corre nightly (pg_cron 11:00
  UTC), hourly (`evaluate_automations()`, 9 reglas) y por triggers AFTER en
  cases/activities/opportunities/tasks/payments. Esas columnas son system-write-only
  (`doctors_guard`).
- **KPI ground truth**: caso nuevo = `cases.is_new_case` (etapa Noloco `I_1` SOLO); casos pagados =
  ledger `payments` (1.046 filas, import-only, `external_key` idempotente); metas en `goals`
  (paid_cases ago-dic 24/26/28/30/30).
- **Señales existentes**: `alerts` (dedupe por índices parciales únicos), `tasks` (5.060 pendientes,
  0 completadas — flood de `prospecto_sin_seguimiento`, NO usar como señal), `activities` (4.454,
  96% tipo nota), `wa_conversations` (1.487 chats, solo metadata, `wa_messages` VACÍA),
  `audit_log` (append-only, source: app|automation|import), `score_snapshots` (1 solo día).
- **Identidad de escritura**: runtime usa SOLO el cliente anon con sesión de usuario (RLS);
  service-role solo en scripts/. CRÍTICO: con service-role `is_system()`=true ⇒ los triggers
  `doctors_guard` y `doctors_journey_sync` NO corren ⇒ mover etapas por service-role NO dispara
  las Conversiones 1/2. Por eso: **los agentes nunca escriben tablas CRM; las acciones aprobadas
  se ejecutan con la sesión del usuario** vía server actions existentes.
- Datos = snapshot único del 8/8/2026 (8 imports manuales, `sync_runs`). Sin sync recurrente ⇒
  el Context Engine debe declarar frescura y degradar confianza.

**Código (Next 16.3, App Router, Turbopack, tsc limpio):**
- Todo es RSC + server actions ("use server", FormData, retorno `{error?|ok?}`). No hay app/api/,
  no hay SDK de AI, no hay colas, no hay realtime. `proxy.ts` (middleware) redirige todo lo no
  autenticado a /login.
- Lecturas viven inline en las páginas (doctores/[id] hace el Promise.all de 8 datasets que ES el
  Doctor360); no había capa de lectura reutilizable → los AI tools la crean extrayendo esas queries.
- Escrituras canónicas reutilizables como ejecutores de acciones aprobadas: `createTask`,
  `completeTask`, `logActivity`, `createOpportunity`, `moveOpportunityStage`,
  `moveAcquisitionStage`, `moveActivationStage`, `updateDoctorContact`, `updateProspectProfile`,
  `resolveAlert`/`dismissAlert`.
- UI: shadcn "base-nova" sobre @base-ui/react (NO Radix), Tailwind v4, es-MX, navy #001d57,
  patrón de aprobación ya existente (forms resolve/dismiss de alerts en /hoy).

**Dominio (data/cuestionario_comercial_keepsmiling.md, 40 preguntas):**
- Precedencia: criterio de Pancho (8/8/26) > documentos > inferencia.
- Contrato HITL ya decidido (P34): la AI propone, **Juan da el click final en todo**; blacklist se
  construye desde sus rechazos.
- Guardrails duros documentados (ver Brain §3): viabilidad, etapas=refinamientos, firewall de país,
  descuentos solo por campaña, 4 frases prohibidas de CP07, contacto significativo ≠ touch.

---

## 2. Arquitectura de agentes propuesta

9 agentes, cada uno con objetivo, herramientas, decisiones y output distintos. Ningún registro de
doctor nuevo: todos operan sobre el mismo Doctor 360.

| Agente (key) | Objetivo | Segmento / disparador | Tools distintivas |
|---|---|---|---|
| `orchestrator` | Entender al doctor completo, decidir qué agente(s) intervienen y con qué prioridad; resolver conflictos | Todos | routing determinístico + síntesis |
| `acquisition` | Llevar prospecto a interés real de acreditación (llamada→videollamada; trigger consultorio nuevo) | Universo A, `acquisition_stage` identificado→reunion_realizada | getProspects, searchDoctors |
| `accreditation` | Convertir interés en acreditación concretada (C1) | Universo A, interes_acreditacion / acreditacion_agendada | getAccreditationHistory, getProspects |
| `activation` | Construir CONFIANZA hasta el primer caso: caso propio (50%) → primer caso paciente (50%) → C2. Nunca pedir volumen | Universo B, en_activacion/activado, día 75 = alerta | getAccreditedNotActivated, getDoctorCases |
| `clinical_education` | Resolver inseguridad técnica (miedo #1 MX = desconocimiento); ofrecer viabilidad, nunca opinar de un caso | clinical_confidence baja, objeción clínica, viabilidad pendiente; default con Rocío | getClinicalInteractions, getTrainingHistory |
| `growth` | Desarrollar 1-2 casos → ritmo sostenido; palanca clínica (alineadores como sistema vs brackets), categoría, KeepDay | Universo B activo/growth sano; salto 1→5-10 casos | getDoctorCases, getDoctorOpportunities, getCasesByPeriod |
| `retention_reactivation` | Detectar caída de ritmo y recuperar dormidos por punto de abandono (grupos A/B/C/D); curiosidad, no reclamo | en_riesgo (retención) / dormido, perdido recuperable (reactivación) | getAtRiskDoctors, getDormantDoctors |
| `doctor_success` | Destrabar casos/servicio ANTES que cualquier objetivo comercial (SERVICE/TRUST > GROWTH) | Casos estancados (aprobacion_pendiente, caso_atrasado), service_issues | getServiceIssues, getDoctorCases |
| `commercial_director` | Responder al manager: pipeline, forecast, equipo, oportunidades cross-agente | Solo invocación de usuario (Ask Your CRM, brief) | getPipeline, getForecast, getGoals, getSalesRepPerformance, getDoctorSegments |

**Regla fundamental** (codificada en el router, no en prompts): los agentes no compiten. Un doctor
puede tener varios agentes involucrados; el primario se elige por esta prioridad:
`doctor_success` > `retention` > `clinical_education` (como handoff) > `activation` >
`accreditation` > `acquisition` > `growth`. Ejemplos del spec: growth prospect con caso trabado ⇒
gana doctor_success; alto potencial recién acreditado ⇒ activation construye confianza, no pide 5 casos.

## 3. Shared Commercial Brain

`lib/ai/brain/` — fuente central versionada (`BRAIN_VERSION = "2026.08.2"`, Commercial Brain V1),
NUNCA copiada entera en cada prompt. **Es la única fuente de doctrina comercial**: no existe un
segundo cuerpo de conocimiento.

**Jerarquía de fuentes** (resuelve cualquier contradicción, declarada en el propio Brain):
1. decisión del dueño/país → 2. configuración vigente en el CRM → 3. material oficial →
4. datos observados → 5. inferencia de la IA (siempre marcada como inferencia, nunca convertida
en hecho).

**24 secciones**, agrupadas:

- **Núcleo — lo lleva TODO agente** (`CORE_SECTION_KEYS`): `identity` (socio clínico y comercial,
  no vendedor de alineadores), `brand_values` (los 5 atributos en orden + servicio y confianza
  ganan siempre), `doctor_value` (qué compra realmente el doctor: confianza clínica primero,
  una empresa que responda segundo; nunca quemar a un doctor para cerrar un mes),
  `commercial_philosophy` (jerarquía de fuentes, evidencia primero, "no sé" es válido, diagnosticar
  antes de vender, alto seguimiento/baja presión, a veces la respuesta es hacer menos o llamar a
  una persona, medir resultados no actividad), `mexico_culture` (usted, cero voseo, no leer el
  silencio como rechazo, miedo #1 = la técnica, cadencia dinámica), `communication` (formulaciones
  preferidas vs prohibidas, ejemplos por situación, tono interno ≠ tono externo), `guardrails`,
  `pending_definitions`.
- **Journey**: `accreditation` (puerta de entrada, no "pague un curso"), `activation` (acreditado ≠
  activado; caso propio → primer paciente → segundo; ¿cuál es el bloqueo?), `growth` (el salto lo
  produce la confianza en la técnica; el competidor puede ser los brackets), `retention` (tres
  causas MX + playbook por causa + cadencia relativa al propio doctor).
- **Clínica y servicio**: `clinical` (regla 90% + viabilidad, nota de voz, frases prohibidas),
  `clinical_owner` (el equipo clínico como activo comercial, prioridad 1-7, no hardcodear a una
  persona), `service` (el servicio manda sobre la venta; severidad e impacto real; un solo equipo).
- **Oferta**: `pricing` (paquete, no fragmentar, el descuento no es la primera respuesta,
  escalera de categorías sin porcentajes), `products`, `competition`.
- **Sistema**: `memory` (memoria basada en evidencia; la memoria existe para no repetir),
  `routing` (pregunta central, jerarquía de necesidades, las 6 preguntas de la próxima mejor
  acción), `lifecycle`, `programs` (KOS/KeepDay), `escalation`, `management` (dirección de país:
  proteger el mes que viene).

**CERO números comerciales en el Brain.** Precio de lista, descuentos y campañas viven en
`commercial_offers` (migración 0025) y se leen con `getActiveCommercialOffers`. Sin fila vigente,
la salida literal es "no hay una condición comercial vigente configurada". Un chequeo de regresión
falla si aparece un precio o un porcentaje cotizable en las secciones de acreditación o precio.

API: `getBrainSections(keys: BrainSectionKey[]): string` — cada agente declara qué secciones
necesita; el runner las compone en el system prompt (con `cache_control` para prompt caching).
Toda recomendación registra `brain_version`.

## 4. Context Engine

`lib/ai/context.ts` — `buildDoctorContext(doctorId)` arma un `DoctorContext` tipado (ver
`lib/ai/types.ts`) reutilizando las queries del Doctor 360 + derivados:

- Base: fila doctors completa (scores cacheados incluidos), cases, opportunities, tasks,
  activities (200), alerts abiertas, wa_conversations, contacts, doctor_ai_profile,
  ai_recommendations abiertas.
- Derivados clave: `days_since_meaningful_contact` — **contacto significativo** = activities de
  tipo llamada/reunion/visita/revision_clinica/keepday (whatsapp/email/nota = touch, NO resetean el
  reloj; regla del corpus P32); `stalled_cases` (fecha_video sin fecha_aprobacion_video >7d, o >6d
  sin avance de etapa de diseño); `historical_case_frequency` (avg_interval_days + confidence);
  `service_issues` (alerts de reglas caso_atrasado/aprobacion_pendiente + casos estancados).
- Frescura: `data_as_of` viene de `sync_runs` (max watermark) — el runner la inyecta y los agentes
  citan "datos al {fecha}" y degradan confianza si >7 días.
- Filtra `is_demo=false`. Fechas siempre con `lib/dates.ts` (America/Mexico_City).
- NO manda toda la base al modelo: el contexto es un resumen tipado ~compacto; detalle adicional se
  consulta vía tools.

## 5. Tool registry

`lib/ai/tools/` — herramientas server-side tipadas (zod), validadas, con allowlist por agente.
**Nunca SQL arbitrario; nunca escritura directa a tablas CRM.**

Lectura (extraídas de las queries de páginas): `getDoctor360`, `searchDoctors`,
`getDoctorTimeline`, `getDoctorCases`, `getDoctorOpportunities`, `getDoctorTasks`,
`getAccreditationHistory`, `getTrainingHistory`, `getClinicalInteractions`, `getServiceIssues`,
`getPipeline`, `getForecast`, `getGoals`, `getSalesRepPerformance`, `getAtRiskDoctors`,
`getDormantDoctors`, `getAccreditedNotActivated`, `getProspects`, `getCasesByPeriod`,
`getDoctorSegments`.

Borradores (no ejecutan nada; devuelven el draft que el agente incorpora a su recomendación):
`createTaskDraft`, `createMessageDraft`, `createActivityDraft`, `proposeDoctorUpdate`.

Cada tool: `{name, description (cuándo usarla), zodSchema → JSON Schema strict, handler(supabase, args)}`.
El registry expone `getToolsForAgent(agent)` según la tabla del §2 + set común.

## 6. Reglas de ruteo (Orchestrator)

Determinísticas, en código (`lib/ai/orchestrator.ts` → `routeDoctor(ctx)`), auditables y gratis —
el LLM se usa para analizar, no para rutear:

1. `doctor_success` si hay service_issues o stalled_cases (SERVICE/TRUST primero).
2. `retention_reactivation` si lifecycle en_riesgo (retención) o dormido/perdido ≤365d+recuperable
   (reactivación); dormidos se segmentan por punto de abandono, hipótesis MX: falta de pacientes o
   técnica, NO falla de servicio.
3. `clinical_education` como involvement (usualmente handoff) si clinical_confidence baja /
   objeción principal clínica / viabilidad en juego.
4. `activation` si universo B con <1 caso de paciente pagado (incluye caso propio pendiente);
   1-2 casos ⇒ growth en modo desarrollo con nota de activación reciente.
5. `accreditation` si universo A en interes_acreditacion/acreditacion_agendada (o
   reunion_realizada con interés alto).
6. `acquisition` si universo A en etapas anteriores (no_interesado ⇒ nadie, salvo señal nueva).
7. `growth` si universo B activo/growth/reactivado sano.
8. `commercial_director` nunca se rutea por doctor: solo lo invoca el manager.

Devuelve todas las `involvements` con razón (para labels de UI) y un `primary`. Un mismo doctor
puede tener p.ej. [doctor_success (primario), growth, clinical_education].

## 7. Cambios de modelo de datos

Migración `supabase/migrations/0017_ai_layer.sql` (idempotente — no hay ledger de migraciones):

- **`ai_recommendations`** — feedback loop (spec + extensiones): id, doctor_id (nullable para
  recomendaciones de director), agent, run_id, brain_version, model_version,
  recommendation_type, objective, situation, recommended_action, channel
  (whatsapp|call|video|visit|clinical|task), recommended_date, why jsonb, evidence jsonb
  ([{field,value,source}]), confidence 0-100, commercial_priority 0-100, clinical_handoff bool,
  handoff_agent, suggested_message, requires_user_confirmation bool default true, payload jsonb
  (draft estructurado p/ ejecutar: task/activity/profile_update), status
  propuesta|aceptada|descartada|ejecutada|expirada, decided_by, decided_at, dismiss_reason,
  action_completed bool, executed_ref jsonb, outcome, created_at, resolved_at.
  Dedupe estilo alerts: índice único parcial (doctor_id, agent, recommendation_type) WHERE
  status='propuesta'.
- **`doctor_ai_profile`** — memoria cualitativa controlada (1:1 doctors): experience_with_aligners,
  clinical_confidence (alta|media|baja|desconocida), main_concerns, preferred_contact_style,
  business_goals, growth_ambition, known_objections, competitor_relationship,
  previous_bad_experiences, relationship_notes, team_readiness, patient_acquisition_problem,
  education_needs, updated_by, updated_at, last_source (humano|ai_confirmado). Se actualiza SOLO
  por input humano o propuesta AI aceptada (recommendation_type='profile_update').
- **`agent_runs`** — observabilidad: agent, doctor_id, trigger (doctor360|hoy|ask|manual),
  requested_by, model_version, brain_version, status (ok|error|refusal), error, latency_ms,
  input_tokens, output_tokens, tools_called jsonb ([{name,args,ms,rows}]), records_used jsonb,
  recommendation_ids uuid[], created_at. Responde "¿por qué recomendó llamar a este doctor?".
- RLS estilo casa: SELECT para authenticated; INSERT solo service-role; en ai_recommendations,
  UPDATE por authenticated limitado por guard trigger a los campos de decisión
  (status/decided_*/dismiss_reason/action_completed/outcome). Convención `app.source='agent'`
  para audit.

## 8. Schemas de output estructurado

`lib/ai/schemas.ts` — zod. Todos los agentes emiten `AgentRecommendation` (el JSON del spec, campos
§7) vía la tool `emit`. NO va en modo `strict`: el payload `profile_update` es un objeto abierto y
el modo strict de la API rechaza el schema con 400 al compilarlo. La garantía la da el `safeParse`
de zod en el runner, que ante un output inválido devuelve los errores como `tool_result` con
`is_error` y el modelo corrige y re-emite. El orchestrator emite `OrchestratorAssessment`
(ai_summary + involvements + next_best_action) y el director `DirectorBrief` (respuesta + hallazgos
+ recomendaciones citando evidencia). Regla EVIDENCE FIRST en el schema: `why` (inferencias
marcadas), `evidence` (facts con campo y valor) — nunca presentar inferencia como dato; prohibido
"el doctor tiene miedo" si no está registrado.

## 9. Modelo de permisos / seguridad

- LLM sin acceso a SQL; solo tools del registry con allowlist por agente y schemas validados.
- Rutas `/api/ai/*` verifican sesión Supabase adentro del handler (además del proxy); VIEWER no
  puede invocar agentes ni decidir recomendaciones (`can_write()` en RLS + check en action).
- Escrituras del runner (ai_* tables) via cliente service-role encapsulado en `lib/ai/db.ts`
  (única importación permitida del service key en runtime), con `app.source='agent'`.
- La ejecución de una recomendación aceptada corre con la **sesión del usuario** por las server
  actions existentes ⇒ RLS + guards + journey_sync + atribución humana intactos. Campos sensibles
  (owner, categoria, lifecycle) siguen gateados por `is_manager()` — la AI solo los propone.
- `ANTHROPIC_API_KEY` solo server-side (.env.local).

## 10. Human in the loop

V1: los agentes READ/ANALYZE/PRIORITIZE/RECOMMEND/DRAFT/PROPOSE. Nada se ejecuta solo.
Flujo: agente emite recomendación (status=propuesta) → UI la muestra con evidencia + draft →
usuario **Aceptar** (ejecuta el mapeo payload→server action existente: crear tarea, registrar
actividad, etc.; marca aceptada/ejecutada + executed_ref) o **Descartar** (pide motivo →
dismiss_reason, insumo directo de la blacklist futura, contrato P34 con Juan). Enviar
mensajes/mails, cambiar lifecycle/owner/acreditación, cerrar opps, descuentos: siempre humanos
(la AI entrega el draft y el link wa.me/Periskope; no hay send API).

## 11. Feedback loop

`ai_recommendations` guarda cada recomendación con decisión, motivo y outcome. Métricas derivables
(panel en /ajustes): acceptance rate por agente, action_completion, tiempo a decisión, falsas
alarmas (descartadas por motivo), y — cruzando con journey dates — acreditación/activación/casos
post-recomendación. `score_snapshots` diario permite medir movimiento de health/priority después
de acciones aceptadas.

## 12. Integración de UI (dentro del workflow, no página aparte)

- **Doctor 360**: `DoctorAIPanel` en el slot de "Próxima acción recomendada" — AI Summary, Next
  Best Action con why/evidence, badge del agente, acciones sugeridas con Aceptar/Descartar, botón
  "Analizar" (POST /api/ai/analyze). Muestra doctor_ai_profile y permite proponer updates.
- **Hoy**: labels de agente (ACREDITACIÓN/ACTIVACIÓN/GROWTH/RETENCIÓN/CLÍNICA/SERVICIO) en las
  cards de prioridad — vienen del router determinístico, gratis, sin LLM. AI Morning Brief
  on-demand (botón, resultado persistido) arriba de los KPIs.
- **Dashboard (Country Manager)**: AI Commercial Brief + **Ask Your CRM** (chat streaming del
  commercial_director con sus tools de agregación).
- **Ajustes**: sección AI — brain/model version, stats de aceptación, últimos agent_runs
  (auditoría), estado de la API key.

## 13. Orden de implementación (MVP)

0. Contratos (`lib/ai/types.ts`, `lib/ai/schemas.ts`, `lib/ai/brain/index.ts`) + migración 0017
   aplicada a dev. ✅ este repo
1. Commercial Brain (contenido desde el cuestionario). ✅
2. Context Engine + db agente + tool registry. ✅
3. Runner (Anthropic SDK, claude-opus-5, tool loop, agent_runs, refusal handling, caching) +
   9 agentes + orchestrator. ✅
4. Server actions AI (aceptar/descartar/ejecutar) + rutas /api/ai/{analyze,brief,ask}. ✅
5. UI (panel 360, labels+brief en Hoy, Ask CRM en dashboard, sección ajustes). ✅
6. Verificación: tsc, dev server, corrida real contra dev DB, review adversarial. ✅

Fuera de V1 (backlog): cadencia de sync de datos (freshness contract), pgvector/retrieval sobre
notas cuando haya cuerpo de mensajes, briefs programados, medición de outcomes automática,
resolución de abiertos de dominio (descuento MX 50/50, SLA entrega, umbral de silencio).

---

## 14. Estado del review (8/8/2026)

Review adversarial de 4 dimensiones (SDK/loop, datos/SQL, ruteo/dominio, seguridad/HITL): 68
hallazgos. La verificación quedó incompleta (se cortó por límite de uso del modelo), así que 8
tuvieron veredicto formal y el resto se triageó a mano.

**Corregidos:**
- `emit` con `strict: true` + objeto abierto ⇒ 400 en TODA corrida en vivo (era bloqueante).
- `stop_reason: max_tokens` con `tool_use` completos ⇒ 400 en el request siguiente (ahora la
  decisión es por presencia de bloques, no por stop_reason, y se fuerza el cierre).
- `persistRecommendations` se tragaba errores de insert/expire: recomendaciones desaparecían en
  silencio. Ahora se anotan en `agent_runs.error` y solo se devuelven a la UI las persistidas.
- `doctor_id` emitido por el modelo no se forzaba al doctor analizado (la acción aprobada podía
  escribir sobre otro doctor); ahora manda el doctorId del contexto y se valida formato uuid.
- Hueco de ruteo: acreditado con su primer caso hecho pero lifecycle fuera de activo/growth/
  reactivado (típico `activado`, 1 caso) no caía en ningún agente. Ahora va a growth con foco en
  la repetición (C3).
- TOCTOU en `acceptRecommendation`: dos clicks simultáneos ejecutaban el payload dos veces. Ahora
  se reclama la fila con un compare-and-set antes de ejecutar.
- `buildDoctorContext` ignoraba errores de las queries de casos/opps/tareas/actividades/alertas: una
  query caída se volvía "dato cero" para el modelo. Ahora corta con error explícito.
- Tokens: se suman `cache_read`/`cache_creation` (antes el costo se sub-reportaba justo cuando el
  cache funcionaba).
- `activity.type` libre ⇒ ahora enum real de `activity_type`; fechas con formato validado; enteros.
- Dominio: prompt de activación decía "los hitos pesan 50% y 50%" (el 50% es descuento, no peso, y
  está sin resolver); `clinical_education` invertía el vocabulario obligatorio (refinamientos =
  ETAPAS); retención inventaba una taxonomía A/B/C/D que choca con la oficial del corpus; el Brain
  afirmaba el 50/50 como hecho contra su propia sección de abiertos; los guardrails prohibían "las 4
  frases del CP07" sin enumerarlas (ahora están escritas).
- `/hoy`: cualquier alerta abierta contaba como señal de servicio ⇒ badge SERVICIO en doctores sin
  problema. Ahora solo `caso_atrasado`, `aprobacion_pendiente`, `oportunidad_estancada`.

**Dry-run contra la base dev (8/8/2026).** Se ejercitó todo el camino salvo la llamada al modelo,
vía un endpoint temporal ya eliminado: `buildDoctorContext` + `routeDoctor` sobre un doctor real de
cada segmento, las 24 tools del registry y el round-trip de validación del emit.

- Ruteo correcto en los 6 segmentos: prospecto→acquisition, acreditado sin activar→activation,
  activado con 1 caso→growth (el hueco corregido), activo alto volumen→doctor_success con growth
  secundario, en riesgo y dormido→doctor_success con retención secundaria.
- 24/24 tools OK contra datos reales (150-1.950 ms; los listados vuelven 12-21 KB, dentro de lo
  razonable para el contexto). Bloque de contexto: 1.000-1.900 caracteres por doctor.
- Bugs encontrados y corregidos en el dry-run: los tres drafts declaraban `description`, `outcome` y
  `due_date` como `.nullable()` (obligatorios aunque vacíos) en vez de `.nullish()`, así que el
  modelo iba a chocar con errores de validación y quemar iteraciones; el conteo de problemas de
  servicio sumaba `service_issues + stalled_cases` cuando el primero YA incluye al segundo (un
  doctor mostraba "21 casos trabados" siendo 11).

**Hallazgo de datos, no de código:** las 4.257 actividades del CRM son TODAS de tipo `nota` (vienen
de la importación de prospectos). No hay ni una llamada, reunión, visita, revisión clínica o KeepDay
registrada, así que `days_since_meaningful_contact` es null para los 6.416 doctores y el reloj de
contacto significativo no tiene con qué funcionar hasta que el equipo registre contactos con el tipo
correcto. El bloque de contexto ahora dice explícitamente que ausencia de registro no es ausencia de
contacto, para que ningún agente concluya abandono a partir de un dato que no existe. Alertas de
servicio abiertas: 49 doctores sobre 208 acreditados (24%), o sea que doctor_success va a ser
primario en aproximadamente uno de cada cuatro acreditados — alto pero no dominante.

**Pendiente de despliegue:** la migración 0017 se aplicó SOLO a dev (`klujlknadykmsgatqtks`). El
proyecto de producción existe con el mismo esquema, así que las tres tablas `ai_*` no existen ahí
todavía: hay que correr `npx tsx scripts/db-migrate.ts supabase/migrations/0017_ai_layer.sql` contra
prod antes de que la capa AI sirva en producción.

**Pendientes conocidos (no bloquean, documentados):** cap de 1000 filas de PostgREST en los
agregados de `getSalesRepPerformance`/`getCasesByPeriod`/`getForecast` (pueden mentir en volumen
alto); `first_patient_case_status='pagado'` se deriva de `new_case_count>=1` y no del ledger;
ventana de 200 actividades limita `last_meaningful_contact`; contacto significativo excluye TODO
WhatsApp (el corpus solo excluye el "WhatsApp corto"); sin rate limiting en `/api/ai/*`; `lib/ai/db.ts`
sin `server-only`; VIEWER ve botones que siempre fallan; `recommendation_type` es texto libre del
modelo y es clave de dedupe (variantes de wording acumulan propuestas).

## 15. Fase 2 — Commercial Brain V1 (9/8/2026)

Refactor del Brain de 13 → 24 secciones (`BRAIN_VERSION` 2026.08 → **2026.08.2**). No se creó una
segunda fuente de verdad: se migró la existente. Se preservaron versionado, carga por agente,
distinción evidencia/inferencia, aprobación humana, permisos de tools, logging y confianza de datos.

**Contradicciones resueltas** (con la jerarquía de fuentes):

| Tema | Antes | Ahora |
|---|---|---|
| Precio de acreditación | 2.500 presencial / 1.900 virtual (material de curso) | Lista 4.990 MXN + 50% vigente en `commercial_offers` (decisión de dirección 9/8). Los 2.500 documentados ≈ lista con descuento aplicado — inferencia declarada, no confirmada |
| Descuento de arranque | pendiente #1, "no hay número autorizado" | Resuelto por decisión de dirección: 50% acreditación + 50% caso propio + 50% primer caso de paciente, **en configuración**. Sigue pendiente hasta cuándo rigen |
| Escalera de categorías | tabla con 5/10/15/20% en el prompt | Solo los tramos por casos acumulados; los porcentajes salen de configuración |
| Dolor | prohibido prometer ausencia | Además: no meterlo en una conversación comercial (no es un punto prioritario del doctor mexicano) |
| Cadencia | umbrales fijos (día 75, trimestre, 6 meses) | Los umbrales quedan como alertas de gestión; la caída se mide contra la **frecuencia histórica del propio doctor** |
| Rocío | "derivación clínica → Rocío" hardcodeado | `clinical_owner` del doctor, con "el equipo clínico" como fallback y propuesta de asignación |
| Registro de los prompts | voseo rioplatense en 6 prompts y 3 descripciones de tools | Español neutro/mexicano en toda la capa, con chequeo de regresión |
| Churn MX vs. servicio | "el churn MX no es falla de servicio" | Se mantiene como hipótesis por default **sin evidencia**; cuando hay un problema registrado, el servicio manda |

**Lo que salió del texto y pasó a configuración dinámica:** precio de lista de la acreditación,
descuento de acreditación, descuento del caso propio, descuento del primer caso de paciente
(`commercial_offers`, migración 0025, columna nueva `amount_mxn`); los porcentajes de la escalera de
categorías; quién es el clinical owner (`doctors.clinical_owner`). **Lo que se declaró como
PENDIENTE en vez de inventarse:** vigencia de las condiciones, inventario del kit de materiales,
SLA de entrega MX, SLA de respuesta de viabilidad, formato futuro de la acreditación, umbrales de
aprobación de excepciones.

**Cambios de ruteo** (solo donde el Brain lo exigía):

1. **Cadencia relativa** — si el motor marca `en_riesgo` pero la frecuencia personal del doctor
   explica el silencio (≤1,5× su intervalo propio), retención pasa a agente de apoyo con el motivo
   explícito y el doctor vuelve a ser elegible para growth. Fuera de ese margen, retención queda
   primaria citando la relación días/intervalo.
2. **Prioridad de agenda clínica (1-7)** — los niveles 1-3 (viabilidad o duda clínica concreta;
   recién acreditado ≤120 días con hito de primer paciente **conocido** y no cumplido; confianza
   clínica baja) involucran al agente clínico como apoyo. Los niveles 4-7 quedan como nota, para no
   saturar la agenda clínica. Un hito en UNKNOWN no habilita el nivel 2: primero se clasifica.
3. **Hacer menos** — con contacto significativo de ≤2 días, calidad GOOD y nada urgente abierto, el
   ruteo deja escrito que la recomendación correcta puede ser no contactar hoy.

**Tests.** 32 escenarios (los 20 previos + los 12 comerciales del pedido) y 17 chequeos de
regresión, todos sin gastar un token: `npx tsx scripts/eval-routing.ts`. Los 7 chequeos nuevos son
de tono y comportamiento comercial: cero voseo en el texto que ve el modelo; las formulaciones
prohibidas hacia el doctor solo aparecen marcadas como prohibidas; los 9 agentes reciben el núcleo
del Brain; cero precios y porcentajes cotizables en el Brain; cadencia relativa en ambos sentidos;
"no contactar" disponible como salida; el equipo clínico resuelto por `clinical_owner`.

**Límite honesto del harness:** verifica el texto que condiciona al modelo y el comportamiento del
router determinístico. Que el modelo nunca escriba una frase prohibida solo se puede comprobar con
corridas reales — requiere `ANTHROPIC_API_KEY`.

## 16. Fase 3 — Los agentes como especialistas (9/8/2026)

**El contrato de especialista.** `lib/ai/agents/contract.ts` define `AgentSpec` con universo,
misión, KPI primario y secundarios, cuellos de botella que ataca, señales que lee, hipótesis que
puede formular, acciones permitidas y prohibidas, handoffs, priorización de cartera, owners y
canales habituales. `buildSystemPrompt(spec)` **genera** el prompt desde esa declaración: una sola
fuente, sin un segundo texto que se desincronice. Los 9 contratos viven en `lib/ai/agents/index.ts`.

**Cuello de botella como unidad de razonamiento.** `Bottleneck` (21 valores) unifica los bloqueos de
activación, las causas de brecha de crecimiento y las causas de churn en un vocabulario contable. El
ruteo lo calcula, el agente lo ataca, la recomendación lo persiste y el director lo agrega.

**Orden de ruteo A-G** (§29): A calidad de datos → B servicio → C bloqueo clínico → D lifecycle →
E oportunidad comercial → F retención → G growth. La puerta A no es un agente: cuando no hay ninguna
señal dura sobre la que decidir, el cuello es `DATOS_INSUFICIENTES` y la acción es conseguir el dato.
`routing_confidence` (0-100) descuenta por cada cosa que hace dudar del ruteo — incluido el caso que
más duele en la base real: que la decisión la tome un problema de servicio que ninguna persona
verificó.

**Next Best Action completa** (§32): además de qué/por qué/cuándo, cada recomendación declara
`bottleneck`, `owner_role` (SALES / CLINICAL / COUNTRY_MANAGER / OPERATIONS / ADMIN / MARKETING),
`current_stage`, `expected_outcome` y `follow_up_condition`.

**El hallazgo de la crítica de diferenciación.** Un crítico adversarial comparó los 9 contratos y
encontró el defecto que importa: sobre la base real (0% de casos clasificados, 11 owners de 7.034),
las dos recomendaciones más probables son "asignar dueño" y "clasificar el caso", y las podían emitir
los nueve agentes sin regla de desempate — o sea, en la operación real el sistema se comportaba como
nueve prompts iguales aunque en el papel estuviera diferenciado. **Resuelto** en el bloque común:
esas dos acciones las gobierna el cuello de botella (`SIN_DUENO` / `DATOS_INSUFICIENTES`); para
cualquier otro cuello, el agente las declara como límite en `why` y baja su confianza, pero no las
emite. También se agregó el cuello `TIEMPO`, que el crítico detectó ausente pese a estar en el pedido.

**Migración 0026:** NBA + taxonomía de descarte (`dismiss_code`) + `human_edited`/`final_action`
(cómo corrigen los humanos a la IA) en `ai_recommendations`; tabla `agent_handoffs` (quién le pasó el
doctor a quién, con resultado); costo por corrida en `agent_runs` (`cache_read_tokens`,
`cache_write_tokens`, `cost_usd`, `bottleneck`, `trigger_reason`); y `ai_second_case_metrics()`
(adopción vs. prueba, declarando cuántos casos siguen sin clasificar).

**Costo** (`lib/ai/cost.ts`): precios verificados al 9/8/2026 — Opus 5 5/25, Sonnet 5 3/15, Haiku 4.5
1/5 USD por millón; caché de lectura 0,1× y de escritura 1,25× sobre el precio de entrada.

**Tests:** `npx tsx scripts/ai-dryrun-doctor.ts "<apellido>"` audita cualquier doctor sin gastar un
token; `npx tsx scripts/eval-routing.ts` corre **32 escenarios y 20 regresiones**, todo sin modelo.

## 17. Caso trabado: el flujo real (9/8/2026)

Corrección de Pancho al modelo de servicio. El flujo de un caso es:
**ingresa → documentación completa → ortodoncia lo mueve → se publica el video → EL DOCTOR APRUEBA →
se imprime → se manda → tratamiento en curso.**

La consecuencia que cambia todo: **después del envío puede pasar un año sin novedades y es normal** —
el tratamiento está andando. La regla anterior contaba "días sin movimiento de etapa" y metía 387
tratamientos en curso (el 59% de los casos abiertos) como atrasos críticos.

Donde SÍ se traba, y donde hay que pushear, son dos puntos, **los dos del lado del doctor**:
documentación incompleta y video publicado sin aprobar. Y hay dos internos: documentado sin video
(ortodoncia) y aprobado sin imprimir (producción).

Qué cambió en `lib/ai/context.ts`:
- Un caso con `fecha_impresion` **no se reporta nunca** como problema de servicio.
- La detección es por punto del flujo, no por días quietos, y declara **de quién es la pelota**.
- Si la pelota es del doctor, `caso_bloqueado` es false: la acción es empujar, no disculparse.
- Más de 365 días parado ⇒ severidad tope MEDIUM, confianza POSSIBLE, factor `dato_sin_cierre`, y
  deja de afirmarse `paciente_afectado` (no hay dato que sostenga que alguien espera). Se sigue
  mostrando —hay que cerrarlo— pero no secuestra el trabajo comercial del doctor.
- La alerta `aprobacion_pendiente` solo escala si tiene un caso VIVO detrás.

**Por qué el tope es necesario:** `fecha_entrega` está cargada en **0 de 1.017** casos y
`fecha_finalizado` en 359. El CRM no puede saber que un caso terminó. Arreglar el import de la fecha
de cierre desde Noloco es la solución de fondo.

**Efecto medido sobre los 208 acreditados:** de ~96 doctores con algo marcado se pasa a **50 con un
caso vivo** (100 casos), y **94 de esos 100 son de pushear al doctor** — documentación o aprobación.
Solo 6 son atrasos internos. 153 casos viejos quedaron topeados como problema de dato.

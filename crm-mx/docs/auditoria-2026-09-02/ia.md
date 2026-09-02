# Auditoría de la capa de IA — crm-mx

Fecha: 2026-09-02 · Alcance: `lib/ai/**`, `app/api/ai/**`, `components/ai/**`, `lib/actions/ai.ts`, scripts, docs y migraciones 0017/0022/0023/0025/0026/0029. Solo lectura. Rutas relativas a `crm-mx/`.

Cifras base: `lib/ai` = 12.998 líneas (context 1.379, orchestrator 1.381, agents/index 973 con prompts de hasta 1.100 chars por línea, eval 2.549). Brain = 56k chars (24 secciones). System prompts generados: 22–28k chars por agente; Brain por agente: 31–49k chars. Medido en código (runner.ts:187-193): Brain ≈14,6k tokens + prompt ≈9,1k tokens por corrida; un análisis de doctor ≈ USD 0,42 con effort high (guard.ts:9-13), de los cuales 0,19 es escritura de caché (runner.ts:206-208). Verificados con `npx tsx scripts/eval-routing.ts`: 32/32 escenarios y 20/20 regresiones PASAN hoy; `lib/ai/pii.test.ts` 10/10.

Precios de `cost.ts:36-42` contrastados con la tabla vigente de la API: Opus 5 = 5/25 OK; Sonnet 5 hoy es 2/10 (el código tiene 3/15 con "promo hasta 31/8"); Haiku 4.5 = 1/5 OK. Opus 5 sí acepta `tool_choice: {type:"tool"}` (el forzado del emit en runner.ts:269-271 es válido); si `AI_MODEL` se cambiara a `claude-fable-5-1` ese forzado devuelve 400 y el modelo no está en `PRECIOS` (se estimaría a mitad de precio).

---

## 1. Tabla agente por agente

Los 9 comparten runner (`runner.ts`), schema de salida (`schemas.ts:156-185`, salvo el director), persistencia (`ai_recommendations`), 11 tools comunes (`tools/index.ts:18-32`) y 8 secciones núcleo del Brain (`brain/index.ts:92-101`). Lo que cambia entre especialistas es SOLO el texto del contrato (`agents/index.ts`) y 1–4 tools distintivas.

| Agente | Para qué existe | Trigger REAL | Input | Output | Tools (además de las 11 comunes) | Modifica datos | ¿Duplica? | ¿Necesita ser agente? | Costo/corrida | Qué puede fallar |
|---|---|---|---|---|---|---|---|---|---|---|
| **orchestrator** | Rutear y sintetizar | Código puro: `routeDoctor()` (orchestrator.ts:640-986). **Su prompt (agents/index.ts:25-125, 22k chars) NUNCA se manda a un modelo**: no existe `runAgentLLM("orchestrator")`; solo lo lee `scripts/ai-dryrun-doctor.ts:80` y el harness. Inserta una corrida sintética sin tokens (orchestrator.ts:1355-1378). | `DoctorContext` (16 queries, context.ts:459-565) | `OrchestratorAssessment` (routing_reason, evidence, bottleneck, data_quality); no se valida con `orchestratorAssessmentSchema` (schemas.ts:187, sin usos) | ninguna (no corre LLM) | `agent_runs` (sintético), `agent_handoffs` (orchestrator.ts:1163-1188) | Su spec dice "audito routeDoctor y disiento" — jamás ocurre | **No.** Ya es código. El contrato de 100 líneas es peso muerto que finge un agente. | USD 0 | Nada; el riesgo es de mantenimiento: el equipo cree que hay un 9º agente. |
| **acquisition** | Prospecto → interés real (universo A temprano) | Botón "Analizar con AI" (Doctor 360) cuando el router lo elige primario | contexto + instrucción (orchestrator.ts:1219-1246) | 1–3 `AgentRecommendation` | getProspects | `ai_recommendations` (propuesta); vía HITL: tasks/activities/profile | Misma salida, mismas reglas; difiere solo por persona | Parcialmente: redactar el WhatsApp de primer contacto sí es IA; decidir "construir interés" ya lo decidió el router | ≈0,42 (1ª/hora) · ≈0,22 con caché | Emite "asignar dueño" (SIN_DUENO domina en A) → gasto Opus para una regla trivial |
| **accreditation** | Interés → acreditación concretada (C1) | Idem, `interes_acreditacion`/`acreditacion_agendada` | idem | idem | getAccreditationHistory, getProspects | idem | Prompt casi idéntico a acquisition salvo la oferta (getActiveCommercialOffers) | Sí para el mensaje con precio/condición vigente; el "cerrar fecha" es una tarea determinística | ≈0,42 | Citar un número: mitigado por offers.ts; sigue dependiendo de que el modelo llame la tool |
| **activation** | Acreditado → caso propio → 1er paciente (C2) | Idem, `is_accredited && first_patient ≠ COMPLETED` (hoy: casi todo el universo B, con hitos UNKNOWN) | idem | idem | getAccreditedNotActivated, getViabilityStatus | idem | Con los hitos UNKNOWN su salida real es "clasificar N casos" (DATOS_INSUFICIENTES) — idéntica a la de cualquier otro agente | **Hoy no**: el 0% de clasificación hace que su recomendación sea determinística (link a /calidad) | ≈0,42 | Paga Opus para producir "clasifica los casos" |
| **clinical_education** | Resolver inseguridad técnica; pedir viabilidad, nunca juzgar el caso | Primario si viabilidad abierta/objeción clínica/confianza baja (nivel 1/3); **segunda corrida** de apoyo (orchestrator.ts:1292-1324) | idem | idem | getClinicalInteractions, getTrainingHistory, getViabilityStatus, requestViabilityDraft | idem (+ payload task de viabilidad) | getTrainingHistory ⊂ getClinicalInteractions (read.ts:839-943, misma query) | Sí para el mensaje clínico; el "pedir viabilidad" es un template (viability.ts:157-267 ya lo arma casi entero sin modelo) | ≈0,22–0,42; **duplica el costo del doctor** cuando corre de apoyo | Nada del ciclo de viabilidad se escribe (0022) — la tool lo pide "a un humano" |
| **growth** | 1–2 casos → ritmo sostenido, categoría, programas | Primario solo con `first_patient = COMPLETED` (hoy ≈ nadie por hitos UNKNOWN) | idem | idem | getCasesByPeriod, getViabilityStatus | idem | Carga 8 secciones del Brain (la más pesada de los especialistas: 38k chars) | Sí (interpretar brecha y proponer palanca) — cuando haya datos | ≈0,45 | Hoy casi inalcanzable por ruteo; cuando corre, KOS/campañas son `null`/[] (context.ts:1088-1089) |
| **retention_reactivation** | Caída de ritmo / dormidos | `en_riesgo` (si cae contra su propia frecuencia), `dormido`, `perdido ≤365d` | idem | idem | getAtRiskDoctors, getDormantDoctors (tools de CARTERA en una corrida por doctor) | idem | Cadencia relativa ya la calcula el router (orchestrator.ts:307-326); el agente la repite | Sí para el mensaje "con curiosidad, no reclamo"; el diagnóstico de cadencia es código | ≈0,42 | Con `interaction_data_quality=POOR` en toda la base, no puede afirmar nada → recomendaciones vagas |
| **doctor_success** | Servicio antes que venta; loop cerrado CON el doctor | Primario si severidad HIGH/CRITICAL o impacto; **segunda corrida** de apoyo si no | idem | idem, con "dos movimientos" (tarea interna + follow_up) | getServiceIssues (RPC global; el contexto ya trae `service_issues`) | idem | Sus 6 piezas (qué/quién/cuándo/aviso) salen de `stalled_cases` + `stalledMeta` (context.ts:653-733): la tarea interna es determinística | Sí para el mensaje de reconocimiento; la tarea interna y el owner_role son reglas | ≈0,22–0,42 · segunda corrida en la mayoría de doctores con alerta | Casi todo `derivado/POSSIBLE` → el prompt mismo le dice "verificar antes de disculparse" |
| **commercial_director** | Responder al manager (Ask) y brief matinal | POST /api/ai/ask (dashboard), POST/GET /api/ai/brief (/hoy), **cron 13:00 UTC** (vercel.json) | pregunta libre ≤2000 chars o instrucción fija (director.ts:28-39) | `DirectorBrief` (answer+findings+recs+dataset) | 12 tools de agregación (tools/index.ts:51-64) + 11 comunes = 23 tools | `ai_recommendations` (recs con `doctor_id` null o el que emita el modelo) | Brain de 49k chars (13+8 secciones) | Ask: sí (pregunta abierta). **Brief: no** — meta/pagados/acreditaciones/riesgo son 4 RPCs fijos; el modelo solo debería redactar 150 palabras | No medido en código; estimado 0,6–1,2 USD (brain 1,6× mayor, 5–8 iteraciones con JSON de hasta 50 filas). Cron ≈ USD 20–35/mes | Una tool con `meta.complete=false` ignorada por el modelo; recs sin doctor no las ve nadie (ver §3) |

Costo total por doctor: 1 corrida ≈0,42 (o ≈0,22 en la misma hora); con apoyo (clínica/servicio) ≈0,65–0,85. Tope diario 25 USD (guard.ts:26-36) ≈ 40–60 doctores/día.

---

## 2. Duplicaciones y código muerto

### 2.1 Prompts repetidos (agents/index.ts)
- El párrafo "estado de la base" está en 6 specs (líneas 119, 325, 432, 750, 854, 957): "0% casos clasificados, 0% interacciones, 0 clinical_owner, 11 de 7.034 owners". `11 de 7.034` aparece 10 veces; `0% de` 12; `interaction_data_quality…POOR` 33; `clinical_owner` 44. **P1**: son cifras de agosto congeladas en el prompt; a medida que /calidad clasifique, el modelo seguirá leyendo "0%". Ya existe `ai_data_quality()` (0023:64) y `DataReadiness` lo consume: debe inyectarse en runtime, una vez, no 6 veces por prompt.
- La regla "los números salen de getActiveCommercialOffers" vive en 4 capas: 12 menciones en specs + brain `guardrails` (sections.ts:173) + descripción de la tool (offers.ts:70) + `instruccion` en la respuesta (offers.ts:145,167). Con una alcanza (la tool).
- "Cero voseo / trato de usted": REGLAS_SALIDA (contract.ts:155-160) + brain `communication` + 3 specs + chequeo del harness (harness.ts:743).
- REGLAS_SALIDA (contract.ts:107-174, ~5k chars) se serializa dentro de cada systemPrompt: se cachea, pero son 9 copias del mismo texto en 9 prefijos distintos de caché (cada agente paga su propia escritura de caché de 2× en la 1ª corrida de la hora).

### 2.2 Brain
- Ninguna sección queda sin cargar. Pero `clinical_owner` la cargan los 9 y `lifecycle` 8 de 9: son núcleo de facto y deberían ir a `CORE_SECTION_KEYS` (brain/index.ts:92) en vez de repetirse en cada lista. `memory`, `clinical`, `management` tienen un solo consumidor.
- El núcleo (8 secciones, ≈22k chars ≈6k tokens) viaja a TODAS las corridas, incluida la del director que nunca habla con un doctor (`mexico_culture`, `communication` son para redactar mensajes).

### 2.3 Tools redundantes
- `getDoctor360` (read.ts:348-401) reconstruye `buildDoctorContext` (16 queries) y devuelve `contextToPromptBlock`, que el orquestador ya puso íntegro en el user message (orchestrator.ts:1282-1284). Cuando el modelo la llama, paga dos veces el mismo bloque. Medido: ~5 iteraciones de tools por corrida (runner.ts:192) pese a "usa tools SOLO si te falta un dato".
- `getTrainingHistory` (read.ts:839) ⊂ `getClinicalInteractions` (read.ts:893): misma query, una filtra `in(revision_clinica, keepday)` y la otra `eq(revision_clinica)`.
- `getServiceIssues` (RPC global) para un doctor puntual repite `ctx.service_issues` ya renderizado (context.ts:1299-1313).
- Tools de cartera (`getProspects`, `getAtRiskDoctors`, `getDormantDoctors`, `getAccreditedNotActivated`, `getCasesByPeriod`) asignadas a especialistas por-doctor (tools/index.ts:38-48): en una corrida sobre UN doctor solo agregan tokens de definición y tentación de llamarlas.
- `defineTool` + `bail` copiados en read.ts:61-82, offers.ts:27-43, viability.ts:36-52 (+ `defineDraftTool` drafts.ts:48). `UUID_RE` en guard.ts:41, runner.ts:563, viability.ts:23, y los 2 scripts. `PROFILE_FIELDS` en drafts.ts:28, lib/actions/ai.ts:17, doctor-ai-panel.tsx:30. `ACTIVITY_TYPES` en drafts.ts:17-26 **sin `videollamada`** mientras schemas.ts:80-90 sí lo tiene (0038 lo agregó al enum): la tool de borrador rechaza lo que el emit acepta.
- `morning-brief.tsx:146-199` y `ask-crm.tsx:136-189` renderizan el mismo brief (findings/evidence/recs) con markup copiado. `requireSession` (guard.ts:55-80) duplica `decisionClient` (lib/actions/ai.ts:36-53). El comentario de `maxDuration = 300` está pegado 3 veces (analyze/ask/brief route.ts:8-15).

### 2.4 Código muerto (verificado con grep en app/, components/, lib/, scripts/)
- `routeDoctorFromRow` (orchestrator.ts:1000-1152, 150 líneas): 0 llamadores. El comentario dice "labels de /hoy"; `/hoy` no lo importa.
- Spec + systemPrompt del `orchestrator` (agents/index.ts:25-125): nunca llega a un modelo (ver tabla).
- `orchestratorAssessmentSchema` (schemas.ts:187-196), `DISMISS_CODES` (schemas.ts:57-66), `DismissCode`/`DISMISS_CODE_LABELS` (types.ts:134-153), `OWNER_ROLE_LABELS` (types.ts:68-75): 0 usos. La taxonomía de descarte de 0026 (`dismiss_code`) **no está implementada**: `dismissRecommendation` guarda texto libre (lib/actions/ai.ts:266-277; recommendation-card.tsx:268-275). El KPI primario del orquestador (agents/index.ts:35) depende de esos códigos.
- Columnas de 0026 que nadie escribe: `dismiss_code`, `human_edited`, `final_action` (0026:29-33); `ai_recommendations.routing_confidence` queda siempre null porque `analyzeDoctor` no pasa `routingConfidence` a `persistRecommendations` (runner.ts:607-615 vs 510). `agent_handoffs.outcome` nunca se actualiza (tabla write-only). `ai_second_case_metrics()` (0026:152-200) no tiene consumidor.
- Harness: detección de "contrato legacy" (harness.ts:38-126) para una forma de `RoutingResult` que ya no existe; `readTsTree` + chequeos que grep-ean código fuente (harness.ts:255-295, 613-720, 743-800): lint por regex disfrazado de test.
- Exports que solo se usan en su propio archivo (sobre-exportación, P3): `priceFor`, `deriveCaseMilestones`, `deriveInteractionQuality`, `deriveServiceImpact`, `buildServiceSummary`, `ALERT_SEVERITY_BASE`, `AGENT_KEYS`, `CHANNELS`, `BOTTLENECKS`, `OWNER_ROLES`, `PROPOSABLE_*`, `*PayloadSchema`, `agentRecommendationSchema`, `mxTimestamp`, `REGLA_90`, `SIN_OFERTA_VIGENTE`, `ALL_TOOLS`, `ALL_SECTION_KEYS`. `pareceTelefono`/`refCorta` solo en tests (por diseño, pii.ts:53-60).
- `types.ts:230` `first_patient_case_date` `@deprecated` sigue calculándose (context.ts:1035-1037).
- scripts/eval-routing.ts:4 dice "20 escenarios"; son 32.

---

## 3. Flujo real

**¿Quién consume `ai_recommendations`?** Solo `DoctorAIPanel` (doctor-ai-panel.tsx:65-78: propuestas + 3 decididas del doctor) y `/ajustes` (conteos por status + últimas 10 corridas, ajustes/page.tsx:126-141). `/hoy` **no** muestra recomendaciones AI (solo el `recommended_action` del motor determinístico, hoy/page.tsx:430). `/calidad` no muestra propuestas `case_subject`/`activity_classification` de la IA: viven únicamente en la ficha del doctor. Las recomendaciones del director con `doctor_id null` (cada Ask y cada brief las persiste: runner.ts:636-646) **no se muestran en ninguna pantalla**: se acumulan como `propuesta`, se expiran entre sí por `(agent, recommendation_type)` (0017:63-65) donde `recommendation_type` es texto libre del modelo (schemas.ts:159) — dedupe débil.

**¿El brief del cron lo lee /hoy?** Sí. Cron (`brief/cron/route.ts:48`, trigger `hoy`, `requested_by null`) → `agent_runs.result` → `GET /api/ai/brief` (brief/route.ts:37-61: último `commercial_director` con trigger `hoy` y status ok) → `MorningBrief` al montar (morning-brief.tsx:43-70). Coherente. Si el cron falla (429 por presupuesto, 5xx) no hay aviso: /hoy muestra el brief de ayer sin decirlo (solo la hora).

**¿`acceptRecommendation` ejecuta qué?** (lib/actions/ai.ts:110-231, con sesión del usuario salvo perfil):
- `task` → insert `tasks` (title/type/due_date/assigned_to=user). **`description` se descarta** (comentario en :117, tasks no tiene columna): el modelo redacta un detalle que se pierde, incluido el de `requestViabilityDraft` (viability.ts:247-249) que llevaba las instrucciones de registro.
- `activity` → insert `activities` + `doctors.last_contact_at = now()` (:150-153).
- `profile_update` → upsert `doctor_ai_profile` con **service role** (:173-183), único write fuera de sesión.
- `case_subject` → update `cases` (guard 0029). `activity_classification` → update `activities`.
- `none`/null → solo marca aceptada.
- La tarjeta **no previsualiza** `case_subject` ni `activity_classification` (recommendation-card.tsx:53-68 devuelve null para esos kinds): el usuario acepta un cambio de dato sin ver qué caso/actividad se toca. **P2**.

**¿Qué pasa si el modelo tarda >300 s?** Vercel corta la función (`maxDuration = 300`, las 3 rutas). El `insert` en `agent_runs` ocurre recién al terminar el loop (runner.ts:383-427) y `persistRecommendations` después: **se pierde todo** — corrida, tokens, costo y recomendaciones — mientras Anthropic ya cobró las requests completadas. El propio código lo documenta para el plan Hobby (analyze/route.ts:8-14); con corridas medidas de 74–144 s y 2 corridas por doctor (hasta 11 requests cada una, runner.ts:71) el techo de 300 s está a 1× de distancia. **P1**.

**¿El costo se registra antes o después?** Después, en un solo insert (runner.ts:383-405). Consecuencias: (a) `gastoDeHoyUSD()` no ve corridas en vuelo → N clicks simultáneos pasan todos el tope; (b) una corrida cortada no cuenta contra el presupuesto ni aparece en /ajustes.

---

## 4. Propuesta de consolidación (9 → 3 + reglas)

Regla: código para reglas claras; IA para interpretar/clasificar/resumir/redactar.

**Lo que hoy paga Opus y debería ser código (gratis, inmediato):**
1. `bottleneck ∈ {SIN_DUENO, DATOS_INSUFICIENTES}` → no llamar al modelo. Emitir en código la recomendación "asignar owner" / "clasificar N casos (link /calidad)" con la evidencia del router. Por los propios prompts (agents/index.ts:119, 957) esto es "casi todo el universo B hoy": es donde se va la mayor parte del gasto y produce lo mismo que un `if`.
2. `contactoReciente && sinUrgencia` (orchestrator.ts:919-937) → recomendación `none` con fecha, sin modelo (hoy es una "nota" que igual dispara la corrida).
3. Tarea interna de servicio (owner_role/fecha/qué falta) → template desde `stalledMeta` (context.ts:653-733); el modelo solo redacta el aviso al doctor.
4. Pedido de viabilidad → `requestViabilityDraft` ya arma el payload sin modelo; que la ruta clínica lo emita directo cuando `viabilityInPlay`.
5. Brief matinal → correr `ai_forecast`, `ai_goals`, `ai_at_risk_doctors`, `ai_service_issues` en código, pasar los números en el user message y pedir solo `answer` (150 palabras) + 3 acciones. Elimina 5–8 iteraciones, el riesgo de "número que no vino de tool" y ~60% del costo del cron.

**Los 3 agentes que quedan:**
- **A. `doctor` (fusiona acquisition + accreditation + activation + growth + retention + doctor_success + clinical_education).** Un solo system prompt cacheado (Brain núcleo + lifecycle/service/clinical/programs + REGLAS_SALIDA) y una **lente** corta por etapa (~1,5k chars: universo/misión/prohibiciones, extraída de los contratos actuales) que el router inyecta en el user message junto con `bottleneck` y `routing_reason`, que ya calcula. Servicio y clínica dejan de ser "segunda corrida": la lente de servicio manda "primera recomendación = recuperación, cero pedido comercial" y el schema ya tiene `owner_role`/`handoff_agent` para distinguir. Tools: solo las por-doctor (`getDoctorTimeline/Cases/Opportunities/Tasks`, `getAccreditationHistory`, `getClinicalInteractions`, `getViabilityStatus`, `requestViabilityDraft`, drafts, `getActiveCommercialOffers`); fuera `getDoctor360` (ya está en el prompt) y las de cartera. Efecto: 1 prefijo de caché en vez de 8, 1 corrida por doctor en vez de 2, mismo schema, misma UI (mantener `agent` = nombre de la lente para no tocar DB ni badges).
- **B. `director`** (Ask). Se queda: la pregunta libre sí es un agente. Sin Brain de redacción al doctor (`communication`, `mexico_culture`) y con el brief pre-computado (punto 5).
- **C. `classifier` (nuevo, barato, batch, Haiku 4.5 o Sonnet 5 effort low).** El cuello real de todo el sistema es "0% clasificado". Primero código: `case_self_similarity()` (0022:48) ≥ umbral → proponer DOCTOR_SELF; luego IA para los ambiguos y para `engagement_quality` de las actividades con texto, en lotes de 50 por llamada, con aceptación humana en /calidad (el HITL de 0029 ya existe). Es clasificación pura: el uso de IA más legítimo y de mayor palanca del CRM, y hoy no existe (`ai_second_case_metrics` devuelve ceros por eso).

Qué se borra: spec del orchestrator, `routeDoctorFromRow`, 6 contratos de ~100 líneas → 6 lentes de ~15, `getTrainingHistory`, compat legacy del harness. `agents/index.ts` pasaría de 973 líneas/187 KB a ~200.

---

## 5. Riesgos

| Sev | Riesgo | Dónde | Detalle |
|---|---|---|---|
| **P1** | Corrida cortada = pagada y no registrada | runner.ts:383-433; app/api/ai/*/route.ts:15 | Insertar `agent_runs` al inicio (`status: running`) y actualizar al final; o streaming. Hoy el tope de gasto es ciego a lo que más cuesta. |
| **P1** | Cifras de agosto hardcodeadas en 6 prompts | agents/index.ts:57,119,139,263,325,432,470,685,750,770,854,893,957 | "0% clasificados", "11 de 7.034", "hoy (9/8/2026)", "284 casos 2025". Se vuelven falsas con el uso y el modelo las cita como hecho. Inyectar `ai_data_quality()` en runtime. |
| **P1** | El gasto se concentra en recomendaciones determinísticas | orchestrator.ts:504-535 + contract.ts:162-169 | Ver §4.1. |
| **P2** | Presupuesto fail-open y sin cuenta de corridas en vuelo | guard.ts:97-98,124-136; cron/route.ts:35-45 | `gastoDeHoyUSD` devuelve null ante error → tope no aplica. Sin lock por `(doctor_id)` ni por usuario: dos pestañas = dos análisis de 0,42 en paralelo. Sin aviso cuando se alcanza el tope (existe `SLACK_WEBHOOK_CRM`). |
| **P2** | Rate limiting: inexistente | app/api/ai/* | Solo rol ≠ VIEWER + tope diario global. No hay tope por usuario, ni cooldown por doctor ("re-analizar cada cuánto" es un pendiente declarado en runner.ts:63-65 / agent_runs.trigger_reason). |
| **P2** | PII en texto libre | context.ts:947-980, 1338-1357; read.ts:452-495 (timeline con `audit_log.old_value/new_value`) | `pii.ts` sí se usa (refOportunidad en context.ts:985, read.ts:638, viability.ts:115,225) y teléfono/paciente estructurados no viajan. Pero `activities.summary/outcome`, `notes`, `tasks.title`, `alerts.reason` y los valores del `audit_log` (si algún día audita `phone`) van crudos. `pii.test.ts` prueba solo escenarios sintéticos. Falta un `pareceTelefono` de advertencia (no abort) sobre el bloque real, al menos en log. |
| **P2** | Aceptar clasificación a ciegas | recommendation-card.tsx:53-68 | Sin preview de `case_subject`/`activity_classification`. |
| **P2** | Taxonomía de descarte no implementada | lib/actions/ai.ts:266-277; 0026:29,51-55 | `dismiss_reason` texto libre; `dismiss_code` nunca se escribe; imposible medir el KPI de ruteo. |
| **P2** | Recomendaciones del director sin dueño ni pantalla | runner.ts:636-646; 0017:63-65 | Cada Ask persiste propuestas invisibles. O no persistir en `ask`, o mostrarlas en /hoy. |
| **P3** | `read-client.ts:20-27` cae a service-role si `getUser()` falla en medio de una request de usuario | read-client.ts | Impacto bajo (RLS = todos leen todo), pero es un bypass silencioso. |
| **P3** | Nombres de personas en prompts | sections.ts:296,316,334,514 (Rocío), 513 (Keudys/Gonzalo), 515,531 + agents/index.ts:61,868,870,874,909,948 (Juan) | El Brain dice "no hardcodear a Rocío" y la nombra 4 veces. Deberían ser `clinical_owner`/`country_manager` resueltos de `profiles`. |
| **P3** | catch silenciosos | orchestrator.ts:1185 (handoff), guard.ts:133, morning-brief.tsx:61 | Aceptables; el de guard es política fail-open declarada. Sin `console.error` en ninguno. |
| **P3** | `task.description` se descarta al aceptar | lib/actions/ai.ts:117 | Si `tasks` no tiene la columna, sacar `description` del schema para que el modelo no la redacte. |
| **P3** | `drafts.ts` ACTIVITY_TYPES sin `videollamada` | drafts.ts:17-26 vs schemas.ts:80-90 | Inconsistencia post-0038. |
| **P3** | Precios/modelos | cost.ts:39; db.ts:30 | Sonnet 5 ya es 2/10. Fable 5.1 no está en `PRECIOS` y rompe el `tool_choice` forzado. |
| — | TODOs | — | No hay TODO/FIXME reales en la capa; solo `@deprecated` en types.ts:230. |

Lo que está bien y conviene no tocar: HITL con sesión de usuario + guard triggers (0017:160-195, 0029), service-role confinado a `ai_*` (db.ts), `enforceRecommendationInvariants` (runner.ts:569-584), `meta.complete` calculado en servidor (runner.ts:94-124), caché en dos puntos con TTL en `cost.ts`, `refusal` chequeado antes de leer content, tope de iteraciones/requests.

---

## 6. Eval harness

- **`npm test` = `tsx --test "scripts/**/*.test.ts" "lib/**/*.test.ts"`** (package.json). `scripts/eval-routing.ts` no es `*.test.ts` → **no corre en `npm test` ni en CI** (`.github/workflows/crm-mx-ci.yml`: typecheck, `npm test`, build). Nadie lo ejecuta salvo a mano; hoy pasa (32/32, 20/20).
- `lib/ai/eval/scenarios.ts` (1.435 líneas) sí entra parcialmente en CI porque `lib/ai/pii.test.ts:15` importa `SCENARIOS`. `harness.ts` (1.114) no entra.
- ¿Vale mantenerlo? **Los 32 escenarios sí**: son la única especificación ejecutable de `routeDoctor` (350 líneas de reglas en orchestrator.ts:640-986) y de la propuesta de consolidación (la lente y el skip determinístico se prueban ahí). Cuesta 10 líneas envolverlos en `lib/ai/eval/routing.test.ts` (`assert(runRoutingEval().every(r => r.passed))`) para que CI los bloquee. **Los 20 chequeos de regresión, no todos**: los 9 conductuales (servicio HIGH ⇒ primario, POOR ⇒ no afirmar inactividad, UNKNOWN sigue UNKNOWN, cadencia relativa, "no contactar") van al mismo test; los que grep-ean archivos fuente (voseo, "withMeta", "summarizeCompleteness", "commercial_offers", tamaño del contrato) son lint frágil: borrar o pasar a un test unitario sobre `buildSystemPrompt` con 3 asserts. Borrar la compat "legacy_involvements" (harness.ts:38-126).
- No existe ninguna eval con modelo (calidad de las recomendaciones, tasa de `emit` inválido, tools llamadas de más). Con `agent_runs.tools_called` ya persistido, un query semanal "tools por corrida / recs por corrida / % dismiss" es más útil que 2.500 líneas sin modelo.

---

## Prioridades (resumen ejecutable)

1. **P1** Registrar `agent_runs` al inicio y actualizar al final (runner.ts:383). Cierra timeout-sin-rastro y presupuesto ciego.
2. **P1** Skip determinístico para `SIN_DUENO` / `DATOS_INSUFICIENTES` / "no contactar hoy": recomendación en código, sin modelo (orchestrator.ts:1277).
3. **P1** Sacar cifras de agosto de los prompts; inyectar `ai_data_quality()` en el user message.
4. **P2** Un solo agente `doctor` con lentes; 1 corrida por doctor; tools por-doctor únicamente; borrar spec del orchestrator y `routeDoctorFromRow`.
5. **P2** Brief pre-computado en código; `ask` no persiste recomendaciones sin doctor.
6. **P2** `dismiss_code` enum en la tarjeta; preview de `case_subject`/`activity_classification`; alerta Slack al tocar el tope.
7. **P2** `lib/ai/eval/routing.test.ts` con los escenarios; podar el harness.
8. **P3** Clasificador batch (Haiku/Sonnet low) para `case_subject`/`engagement_quality` con HITL en /calidad — es la IA que falta.

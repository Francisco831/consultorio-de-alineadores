# Auditoría frontend + producto — CRM KeepSmiling México

Fecha: 2/9/2026 · Alcance: `crm-mx/app/(app)/**/page.tsx`, `app/login`, `app/(app)/layout.tsx`, `proxy.ts`, `components/**` (sin `ui/`), `lib/actions/*`, `lib/{format,dates,phone,forecast,paginar,agenda-brief,brief-doctor,actividad-equipo,types,noloco-pais}.ts`, `lib/supabase/*`. Solo lectura; nada modificado.
Principio a contrastar (README:4): "el CRM te dice qué hacer (Next Best Action), no te pide administrarlo".

Severidades: **P0** rompe el trabajo diario o miente con datos · **P1** bug/deuda que afecta decisiones o seguridad · **P2** fricción o inconsistencia real · **P3** limpieza.

---

## 0. Resumen ejecutivo

1. La arquitectura está bien pensada (dos universos, motor de scoring en SQL, forecast único, brief determinista, HITL para IA), pero la capa de UI todavía **muestra** información en vez de **cerrar el loop de acción**: la tarjeta de prioridad de /hoy dice "→ WhatsApp: retomar contacto" y no tiene botón para registrar que lo hiciste, ni el mensaje, ni posponer. Registrar una llamada desde /hoy son 2 pantallas y 5 interacciones.
2. El bloque "WhatsApp esperando respuesta" está congelado desde el 7/8 (webhook de Periskope sin eventos, lo dice la propia UI en `components/whatsapp/wa-esperando.tsx:123-133`) y sigue ocupando la columna de trabajo de /hoy y /panel. **P0 funcional**: es la única lista "quién me escribió y no le contesté" y es una foto vieja.
3. Hay tres pantallas que compiten por ser "la home" (/hoy, /panel, /dashboard) y cuatro que responden "qué hizo cada uno" (/equipo, /equipo/actividad, /equipo/actividad/calendario, /reportes?t=actividad). /hoy y /panel comparten 4 bloques literalmente.
4. La ficha del doctor tiene timeline, pero no es unificada: faltan tareas creadas/canceladas, movimientos de oportunidades, recomendaciones IA decididas, alertas, eventos asistidos, render enviado/rechazado, pagos y WhatsApp.
5. Deuda técnica concreta con impacto en datos: `/tareas` trae todos los doctores sin paginar (cap 1.000 → tareas caen en "Sin doctor"), `/casos` usa la inferencia de render que `/seguimiento` demostró que miente en un tercio, `fetchAllRows` pagina sin ORDER BY, `/dashboard` y `/prospeccion` no chequean `error` (un fallo se ve como 0), `/equipo` y `/panel` cuentan "contactos" con dos listas distintas.
6. 11 server actions devuelven `Promise<void>` y tragan el error con `console.error` (alertas, calidad, ajustes); 2 tiran `throw` y rompen la pantalla (eventos, metas). Un VIEWER que aprieta ✓ en una alerta no recibe ninguna respuesta.
7. 29 `as unknown as`, 8 copias de `selectClass`, 6 del array de roles manager, 6 reimplementaciones de "hoy en México", 2 paginadores, 3 `median`, 2 `ACQ_RANK`, 2 `LOST_REASONS`, 4 `<Toaster>`.

---

## 1. Mapa de páginas

Convención: **RT** = round-trips serializados al backend (sin contar layout: `getUser` + `profiles` + `touch_last_seen` en `app/(app)/layout.tsx:14-25`, más `proxy.ts:31` `getUser` por request → 3 llamadas de auth por navegación).

| Ruta | Qué muestra / qué pregunta responde | Queries (RT) | Límite 1.000 / paginación | Server actions | Sidebar |
|---|---|---|---|---|---|
| `/hoy` (`hoy/page.tsx`, 588 l.) | Bandeja + dashboard mezclados: saludo, MorningBrief (IA on-demand), AgendaHoy (Calendar), 5 tiles del país (pagados/objetivo, casos nuevos, forecast, gap, contactos del mes), "¿A quién contacto hoy?" (4 motores × 5 doctores con `priority_reasons` + `recommended_action.label`), libreta, tareas de hoy/vencidas (8), WA esperando (8), efemérides, alertas (8). Responde "a quién llamo hoy" y "cómo va el mes"; NO responde "qué quedó pendiente de ayer" ni "qué se está perdiendo" (renders/viabilidades no aparecen). | `getUser` → `profile` (86-90) → Promise.all de 12 items donde `motoresData` son 8 queries (109-128) → `armarAgendaConBrief` (270, +2 si hay agenda). **≈21 queries, 4 RT**. | Todo con `limit`. Ojo: `wa_conversations` `.limit(60)` (184-191) y recién después ordena por bucket 7d y recorta a 8 (257-263): con >60 chats sin responder los "7d" pueden quedar afuera antes de ordenarse. Sin `count` → no muestra "8 de N" (panel sí). | `resolveAlert`, `dismissAlert` (566-577, void) · vía componentes: pendientes, tasks, `marcarRespondido` | Sí |
| `/panel` (`panel/page.tsx`, 844 l.) | Panel personal (?u=): 6 tiles de la persona, AgendaHoy, agenda de tareas en 3 franjas (hoy/vencidas/próximas) con mini-ficha por doctor, reuniones del mes, "Ingresos al CRM" (asistencia del equipo), libreta, QuickLog, WA esperando (de sus doctores), mes por tipo, Noloco por país. Responde "qué tengo planificado" y "cuánto hice este mes". | `getUser` → Promise.all(2) (104-110) → Promise.all(6) (137-188) → Promise.all(7 incl. 4-5 HTTP a Noloco) (214-284) → `armarAgendaConBrief` (301). **≈18 queries + Noloco, 5 RT**. | `activities` `.limit(1000)` (152) sin aviso; `tasks` `.limit(200)` (163); `cases` `.limit(2000)` (230). | `logActivity` (QuickLog), pendientes, `marcarRespondido` | Sí (label = nombre) |
| `/dashboard` (679 l.) | North Star (mismos 4 tiles de forecast que /hoy y /pipeline + acreditados + primeros casos + dormidos), 3 motores con 4 métricas c/u, funnel de 8 escalones, chart 12 meses, top 10 doctores del mes, casos por categoría, Ask Your CRM. Responde "cómo viene el negocio". | 1 Promise.all de **24 queries** (101-190), 1 RT. `getForecastMes` (RPC). | Todo por `count` salvo `chartRaw .limit(5000)` (159), `recentRaw .limit(2000)` (166), `daysToFirstRaw .limit(1000)` sin `is_demo` (185-189). **Ninguna query chequea `error`**: un fallo se renderiza como 0 en tiles y funnel (P1). `accreditedPrevMonth` (148-152) sin `is_demo`. | Ninguna (AskCrm es fetch a `/api/ai/ask`) | Sí |
| `/doctores` (368 l.) | Lista del universo B con filtros por grupo de lifecycle + tag IG, orden por 5 columnas, paginado 50. Responde "quiénes son mis acreditados y cómo están". NO muestra owner, último contacto ni próxima tarea. | 1 query (`count: exact` + `range`). | Correcto. | — | Sí |
| `/doctores/[id]` (714 l.) | Ficha 360: header + 8 métricas, hitos, WhatsApp (Periskope), redes/fechas, perfil de prospecto, observaciones, DoctorAIPanel, tabs (timeline / casos / opps / tareas). | `doctor` (95-100, serial) → Promise.all(9) (103-154) → `DoctorAIPanel` Promise.all(5) (`doctor-ai-panel.tsx:53-91`, RSC anidado). **15 queries, 3 RT**. | `cases select *` sin límite (114-118, por doctor: ok); `activities .limit(200)`, `audit_log .limit(100)`. DoctorAIPanel re-consulta `doctors.recommended_action, priority_reasons` que la página ya tiene (`doctor-ai-panel.tsx:60-64`). | `logActivity`, `createTask`, `createOpportunity`, `moveAcquisitionStage`, `acreditarDoctor`, `updateDoctorContact`, `updateDoctorRedes`, `updateProspectProfile`, `updateDoctorObservaciones`, `editarActividad`, `completeTask`, `cancelTask`, `acceptRecommendation`, `dismissRecommendation` | (detalle) |
| `/pipeline` (241 l.) | 8 tiles (objetivo, pagados, casos nuevos, commit, best case, pipeline, forecast, gap) + kanban de oportunidades (8 columnas) o kanban de activación (`?view=activacion`, 8 columnas de `activation_stage`). | Promise.all(6) (45-88), 1 RT. | `opportunities` abiertas sin `range` (53-57): hoy <1.000, ok; demo incluidas en las sumas por columna (`board.tsx:177`). | `moveOpportunityStage`, `markLost`, `updateOpportunityMeta`, `moveActivationStage` | Sí ("Oportunidades") |
| `/prospeccion` (396 l.) | KPIs de adquisición, funnel acumulado (7 escalones), kanban de 10 columnas (top 30 por prioridad c/u), acreditaciones del año por asesor/fuente/ciudad. | Promise.all(8) donde 2 items son Promise.all(10) → **26 queries**, 1 RT. | `accreditedYearRaw` (85-88) **sin `range`** → cap 1.000 silencioso. **Ninguna query filtra `is_demo`** (86-133) mientras /dashboard sí → los mismos números difieren entre pantallas (P2). No chequea `error`. | `createProspect`, `moveAcquisitionStage` | Sí ("Pipeline") |
| `/prospeccion/lista` (272 l.) | Lista del universo A: 9 tabs por etapa + chip IG, paginado 50. | 1 query. | Correcto. | — | Sí ("Lista") |
| `/seguimiento` (540 l.) | Tres colas de espera externa: renders esperando (agrupados por doctora, semáforo 7/14/90 días), rechazados sin rehacer, viabilidades sin respuesta. Responde "qué está trabado afuera". | Promise.all(3) (103-130), 1 RT. | Sin `range` (hoy ~63+72+N filas). | `registrarViabilidad` | Sí |
| `/tareas` (132 l.) | Tareas mías/equipo partidas en Por acreditarse / Acreditados / Sin doctor. | `getUser` → Promise.all(3), 2 RT. | **P1**: `doctors.select("id, nombre, is_accredited")` (33) sin `range` con 6.4k+ doctores → solo llegan 1.000; las tareas de los otros doctores caen en "Sin doctor" y pierden el nombre (`acreditado[t.doctor_id] === undefined`, 65-67). `tasks .limit(300)`. | `completeTask`, `cancelTask` | Sí |
| `/casos` (234 l.) | Espejo de Noloco, 3 filtros, paginado 50. | 1 query. | Correcto. **P1 de criterio**: "Pendientes de aprobación" (61-64) y la columna Video (140-141) usan `fecha_video sin fecha_aprobacion_video`, la inferencia que `/seguimiento:17-27` documenta como falsa en un tercio; /seguimiento usa `video_stage`/`video_sub_stage`. Dos pantallas, dos verdades. | — | Sí |
| `/calidad` (344 l.) | DataReadiness (qué sabe la IA) + 3 colas de clasificación (managers). | `getUser` → `profile` → Promise.all(6) → `doctors in(ids)` (151-153); DataReadiness Promise.all(15). **4 RT**. | Correcto (counts + limits). | `classifyCaseSubject`, `classifyActivity`, `reviewServiceAlert` (void) | Sí |
| `/reportes` (1.164 l.) | 6 tabs: Producción (casos/mes, top 90d, categoría, zona), Eventos (RPC `evento_roi`), Acreditación (cohortes, days-to-first, calidad por asesor, enfriándose), Pipeline (win rate, motivos, días por etapa), Actividad vs resultados (90d por persona), Calidad de datos (sin teléfono, duplicados, opps sin acción). | Producción Promise.all(3) con `fetchAllRows` ×2 (94-114, **pagina todos los doctores en cada carga**); Acreditación **2 awaits en serie** (446-455) y `docs` sin `range`; Pipeline Promise.all(2); Actividad `fetchAllRows` ×3; Calidad `fetchAllRows` ×3. | Usa `fetchAllRows` pero **sin `.order()`** en ninguna llamada (94-114, 913-931, 1013-1045) → paginación inestable (ver §2.10). Acreditación `docs` (446-452) sin `range`. Calidad `openOpps` (1037-1041) sin `is_demo`. | — | Sí |
| `/equipo` (329 l.) | Tabla por persona (casos, objetivo, opps, actividades 30d, visitas, keepdays, vencidas, último ingreso) + metas del comercial (editable por manager). | Promise.all(8) con `fetchAllRows` ×4 (36-83) → `team_signins` (88) → `getUser` (94-96) → `profile` (97-99). **4 RT**, los 3 últimos serializables. | `fetchAllRows` sin `.order()`; `monthCases`/`openOpps` sin `range` (42-52). | `guardarMetasComercial` (throw) | Sí |
| `/equipo/actividad` (191 l.) | Feed del día por persona (6 fuentes unificadas en `lib/actividad-equipo.ts`). | `fetchActividad`: Promise.all(7) → Promise.all(4). 2 RT, 11 queries. | Sin `range` en ninguna de las 7 (`actividad-equipo.ts:100-141`): para un día alcanza. | — | **No** (link desde /equipo:177 y /panel:543) |
| `/equipo/actividad/calendario` (193 l.) | Calendario mensual: cargas y contactos por día por persona. | Mismo `fetchActividad` pero para **un mes** (34-38). | **P2**: `audit_log` de un mes (cada cambio de campo es una fila) y `activities` de un mes pueden superar 1.000 → los totales del calendario se recortan sin aviso. | — | **No** (link desde /equipo/actividad:90) |
| `/eventos` (214 l.) | Alta de evento con asistentes por nombre (match server-side) + lista desplegable con notas editables. | Promise.all(2), 1 RT. | `events` sin `range` (ok hoy). `crearEvento` pagina **todos los doctores** por cada alta (`events.ts:89-91`). | `crearEvento`, `borrarEvento` (throw), `actualizarNotasEvento` | Sí |
| `/herramientas` (500 l.) | Playbook estático (12 secciones). | 0. | — | — | Sí |
| `/ajustes` (519 l.) | Botones de sistema, objetivos país, automatizaciones (toggle), líneas Periskope, allowlist, stats IA + últimas corridas. | `getUser` → `profile` → Promise.all(4) → Promise.all(5 counts + runs) → `doctors in(ids)`. **5 RT**. | ok. | `recalcularScores`, `ejecutarAutomatizaciones`, `purgarDemo`, `toggleRegla`, `guardarObjetivo` (void), `setLineaPeriskope`, `invitarMail`, `revocarInvitacion` | Sí |
| `/login` (61 l.) | Form email/password. | 0. | — | `signIn` | — |

Huérfanas reales: ninguna (las dos de /equipo/actividad están enlazadas). Pero el **Command Palette** (`components/command-palette.tsx:30-40`) tiene su propia lista de páginas con 9 rutas y le faltan /panel, /prospeccion, /prospeccion/lista, /seguimiento, /eventos, /herramientas, /calidad — dos menús que ya divergieron (P2).

---

## 2. Auditoría técnica

### 2.1 Archivos gigantes (>400 líneas) y qué extraer

| Archivo | Líneas | Extraer |
|---|---|---|
| `app/(app)/reportes/page.tsx` | 1.164 | Un archivo por tab: `components/reportes/{produccion,eventos,acreditacion,pipeline,actividad,calidad}.tsx`. Sacar `monthKey`/`normName` a lib. |
| `app/(app)/panel/page.tsx` | 844 | `components/panel/agenda-tareas.tsx` (filaTarea 412-525 + franjas), `components/panel/reuniones-mes.tsx` (632-677), `components/equipo/ingresos-crm.tsx` (682-721, y moverlo a /equipo), `components/panel/noloco-pais.tsx` (789-839). La mini-ficha (421-439) es un `briefDoctor` a medias: reusar `lib/brief-doctor.ts`. |
| `app/(app)/doctores/[id]/page.tsx` | 714 | `lib/timeline-doctor.ts` (178-258, y ampliarlo, ver §4e), `components/doctor/redes-y-fechas.tsx` (457-559), `components/doctor/whatsapp-block.tsx` (408-455), `components/doctor/casos-table.tsx` y `opps-table.tsx` (607-702). |
| `app/(app)/dashboard/page.tsx` | 679 | Un RPC `dashboard_counts()` reemplaza 20 counts (101-190); `components/kpi-tiles.tsx` compartido; `components/dashboard/funnel.tsx`. |
| `components/doctor/quick-actions.tsx` | 632 | Un componente por diálogo: `dialog-actividad`, `dialog-tarea`, `dialog-oportunidad`, `dialog-acreditar`, `dialog-etapa`, `dialog-contacto`, `dialog-redes`; QuickActions queda como barra de botones + estado `open`. |
| `app/(app)/hoy/page.tsx` | 588 | `components/hoy/priority-card.tsx` (388-467, client, con acciones), `components/hoy/alertas.tsx` (521-583), `lib/queries/hoy.ts` para las 21 queries. |
| `app/(app)/seguimiento/page.tsx` | 540 | Un componente por tab (renders 254-395, rechazados 396-457, viabilidades 458-537) + `lib/seguimiento.ts` con umbrales y `dias()`. |
| `app/(app)/ajustes/page.tsx` | 519 | `components/ajustes/{sistema,objetivos,automatizaciones,ai-stats}.tsx`. |
| `components/pipeline/board.tsx` | 487 | `opp-card.tsx`, `dialog-perdida.tsx`, `dialog-editar.tsx`; el `StageColumn` es el mismo que `JourneyColumn` (`journey-board.tsx:215-257`) → un `kanban-column.tsx`. |
| `components/pendientes/pendientes-card.tsx` | 398 | Máquina de estados "en vuelo" (59-210) sobredimensionada para una libreta: `useOptimistic` + `key` por fila la reemplaza en ~120 líneas (P3). |

### 2.2 Lógica duplicada (con cada copia)

| Qué | Copias |
|---|---|
| `selectClass` (mismo string tailwind) | `components/tasks/task-list.tsx:22`, `pipeline/board.tsx:46`, `panel/quick-log.tsx:16`, `ajustes/lineas-manager.tsx:10`, `doctor/prospect-profile-card.tsx:20`, `doctor/quick-actions.tsx:43`, `seguimiento/registrar-viabilidad.tsx:24`, `prospecting/new-prospect-dialog.tsx:19` → `components/ui/native-select.tsx`. |
| `median()` | `dashboard/page.tsx:53`, `prospeccion/page.tsx:49`, `lib/noloco-sync.ts:57`. |
| `ACQ_RANK` + listas de etapas de adquisición | `dashboard/page.tsx:60-64`, `prospeccion/page.tsx:26-37` (RANK), `prospeccion/page.tsx:69-73` (ACQ_STAGES), `prospeccion/lista/page.tsx:45-55` (ETAPAS), `components/prospecting/journey-board.tsx:58-69` (ACQ_COLUMNS), `dashboard/page.tsx:92-99` (CONTACTADO_PLUS/REUNION_PLUS derivados a mano) → un `ACQ_STAGE_ORDER` en `lib/types.ts`. |
| `monthKey()` | `dashboard/page.tsx:49`, `reportes/page.tsx:31`. |
| Normalizar nombre (`norm`/`normName`) | `reportes/page.tsx:35-43`, `lib/actions/events.ts:14-22`, `lib/actividades-sync.ts:21`. |
| Array de roles manager `["ADMIN","COUNTRY_MANAGER","SALES_MANAGER"]` | `calidad/page.tsx:24`, `equipo/page.tsx:100`, `ajustes/page.tsx:79`, `lib/actions/admin.ts:19`, `lib/actions/allowlist.ts:34`, `lib/actions/team.ts:36` → `lib/roles.ts` (`isManager(rol)`, `canWrite(rol)`). |
| `CONTACTO_TYPES` | `lib/actividad-equipo.ts:27-34` (incluye `keepday`) vs `equipo/page.tsx:146-152` (**sin** `keepday`). **P1**: /hoy:198 y /panel:198 cuentan "Contactos" con keepday; /equipo "Contactos" sin keepday. Además /equipo:162 suma `reunion` como videollamada y /panel:389-391 no → Rocío ve "Videollamadas 3/5" en su panel y otro número en /equipo. |
| "Hoy en México" (`Intl.DateTimeFormat("en-CA", {timeZone})`) | `lib/dates.ts:10` (canónica), `components/tasks/task-list.tsx:45-47`, `panel/page.tsx:362`, `seguimiento/page.tsx:69-71`, `lib/brief-doctor.ts:60-62` (`fechaMX`), `lib/actividad-equipo.ts:82-84` (`diaMX`), `lib/noloco-pais.ts:122-124`. Literal `"America/Mexico_City"` además en `hoy:97`, `equipo:232`, `ajustes:497`, `dashboard:76`, `agenda-hoy.tsx:33`, `morning-brief.tsx:30`. Offset `-06:00` literal en `hoy:199,219-220`, `panel:130,280-281` (existe `MX_OFFSET` en `actividad-equipo.ts:10`). → `lib/dates.ts`: `MX_TZ`, `MX_OFFSET`, `fechaMX(iso)`, `fmtHoraMX`, `fmtFechaCorta`. |
| Diferencia de días | `lib/format.ts:18-21` (`daysSince`), `lib/brief-doctor.ts:66-72` (`diasDesde`), `components/ai/milestone-track.tsx:60-66` (`daysBetween`), `seguimiento/page.tsx:133-135` (`dias`), `prospeccion/page.tsx:164-172`, `reportes/page.tsx:560-567`, `doctores/[id]/page.tsx:53-59` (`aniosCumplidos`). |
| Bloque de 4 tiles de forecast (Pagados/objetivo, Casos nuevos, Forecast, Gap con color) | `hoy/page.tsx:317-353`, `dashboard/page.tsx:320-354`, `pipeline/page.tsx:127-145`. La grilla de tiles (`grid gap-px … bg-border`) está además en `panel:561-572`, `prospeccion:269-283`, `seguimiento:236-252`, `reportes:311-328,1079-1095`, `ajustes:421-440` → `components/kpi-tiles.tsx`. |
| Tarjeta de doctor con botones WhatsApp / Llamar / Ficha | `hoy/page.tsx:388-467`, `panel/page.tsx:412-525` (`filaTarea`), `components/calendar/agenda-hoy.tsx:76-99`, `components/hoy/efemerides-card.tsx:131-144` → `components/doctor/contact-buttons.tsx`. Inconsistencia: /hoy:389 y agenda-hoy:56 usan `waLink` (wa.me personal); /panel:416 y `quick-actions.tsx:88-91` prefieren `periskopeLink`. La regla escrita ("el equipo responde desde Periskope", `wa-esperando.tsx:137`) se cumple en 2 de 4 lugares. |
| Armado de "feed/timeline" | `doctores/[id]/page.tsx:178-258` (actividades ∪ hitos de casos ∪ audit de doctor) vs `lib/actividad-equipo.ts:86-320` (actividades ∪ tareas ∪ opps ∪ eventos ∪ audit de 4 entidades). Dos motores para la misma idea, con fuentes distintas. |
| `profiles.select("id, nombre")` | `hoy:183`, `pipeline:64`, `reportes:933`, `prospeccion:110`, `dashboard:167`, `doctores/[id]:143`, `tareas:30` → `lib/queries/profiles.ts` con `cache()`. |
| `LOST_REASONS` | `components/pipeline/board.tsx:61-68`, `lib/actions/opportunities.ts:9-16`. |
| Topes `MAX_*` | `activities.ts:61-62` ↔ `editar-actividad.tsx:33-34`; `events.ts:125` ↔ `notas-evento.tsx:23`; `doctors.ts:118` ↔ `observaciones-card.tsx:15`; `pendientes.ts:36,101` ↔ `pendientes-card.tsx:43`. El comentario "de un archivo use server no se pueden exportar constantes" es cierto, pero la solución ya existe en el repo: `METRICAS_OBJETIVO` vive en `lib/types.ts:365`. → `lib/limites.ts`. |
| `ACT_LABEL` | `lib/actividad-equipo.ts:13-24` duplica `ACTIVITY_TYPE_LABELS` (`types.ts:335-345`) + `seguimiento`. |
| Primer nombre `split(" ")[0]` | `layout.tsx:29`, `panel:125,553,703`, `hoy:284`, `lib/actividades-sync.ts:255` → `primerNombre()`. |
| Formato de fecha inline (`toLocaleDateString("es-MX"…)`) | `ajustes:221,496`, `equipo:231-237`, `panel:75-87`, `hoy:96`, `dashboard:75`, `morning-brief.tsx:29` — al lado de `lib/format.ts:formatDate`. |
| Dos paginadores | `lib/supabase/fetch-all.ts:13-26` (`fetchAllRows`, usado por pages/actions) y `lib/paginar.ts:15-35` (`traerTodo`, usado por `ledger-reconcile.ts`, `pagos-planilla.ts`) + `scripts/lib/fetch-all.ts`. Solo `traerTodo` pone `ORDER BY`. |
| Nav | `components/app-sidebar.tsx:33-80` (NAV) vs `components/command-palette.tsx:30-40` (PAGES). |
| Columna kanban | `board.tsx:338-376` (`StageColumn`) ≈ `journey-board.tsx:215-257` (`JourneyColumn`). |
| Sincronía props→estado local (`prev !== props`) | `board.tsx:107-111`, `journey-board.tsx:100-104`. |

### 2.3 Código muerto (verificado con grep en `app`, `components`, `lib`)

- `components/coming-soon.tsx` — `ComingSoon` no lo importa nadie. **P3** borrar.
- `lib/types.ts:347-356` `BUCKET_LABELS` — nunca importado (los 8 buckets se colapsan en 4 motores en `hoy:36-66`). **P3**.
- `lib/types.ts:141` `Doctor.expected_next_case_at` y `:132` `health_factors` — existen en la tabla, nunca se renderizan en ninguna pantalla. No es código muerto: es **dato muerto**, y `expected_next_case_at` es la fecha más accionable del universo B ("le toca mandar caso el 12/9"). **P1 funcional**, ver §4c.
- `lib/actions/quality.ts:128-138` acepta `main_topic` y `next_action` opcionales; `components/quality/activity-review.tsx:104-118` nunca los manda → rama inalcanzable. **P3**.
- `lib/actions/tasks.ts:26` lee `assigned_to` del form; ningún formulario lo envía (`quick-actions.tsx:249-282`) → no se puede asignar una tarea a otra persona desde la UI. **P2 funcional**.
- Exports de tipos usados solo en su archivo (cosmético): `ReadinessMetric`, `MiembroEquipo`, `PerfilEquipo`, `DocRef`, `ResumenPaises`, `FilaPais`, `ForecastMes`, `normalizePhone`, `ACT_LABEL`.
- `LIFECYCLE_STYLES`/`LIFECYCLE_LABELS` cargan los 2 estados deprecados (`types.ts:17,266-268`, `format.ts:110-111`): correcto para audit viejo, pero el enum sigue en la DB.

### 2.4 `console.*`, TODO/FIXME

- Sin TODO/FIXME/HACK reales (el grep solo pega en prosa con "todo").
- `console.error` como único manejo de error: `lib/actions/alerts.ts:21-25`, `lib/actions/admin.ts:29,37,45,58,86`, `lib/actions/quality.ts:75,81,97,115,124,147,165,172,183,198`. En Vercel eso va a un log que nadie mira (lo dice el propio `app/api/sync/pagos/route.ts:19`). Ver §2.7.
- `console.log` en `app/api/webhooks/periskope/route.ts:123,199` (fuera del alcance de UI, pero es log de payload).

### 2.5 Hardcodes

| Dónde | Qué | Sev |
|---|---|---|
| `components/ajustes/lineas-manager.tsx:19-25` | 5 números de línea de Periskope con nombres ("Juan", "Dra. Rocío Puig"). Comentario justifica (Periskope no expone líneas por API); igual debería vivir en tabla `periskope_lines` editable desde Ajustes. | P2 |
| `lib/noloco-pais.ts:24-28` | `V2_USER_POR_NOMBRE = { rocio: 121, juan: 12, pancho: 182 }` — mapeo por **primer nombre del perfil**; el día que entre otra Rocío o cambie el nombre, el bloque desaparece o muestra los datos de otra persona. → columna `profiles.noloco_v2_user_id`. | P1 |
| `lib/alerta-rechazos.ts:28` | `"Rocio Puig": "U07D2TZ7PGB"` (Slack user id por nombre). → `profiles.slack_user_id`. | P2 |
| `app/(app)/equipo/page.tsx:322-326` | Texto "cuotas OKR: Juan 18 · Rocío 4→7 · nuevo/a 2→5" en la UI. | P3 |
| `app/(app)/ajustes/page.tsx:239-240` | "rampa H2: ago 24 · sep 26 · oct 28 · nov 30 · dic 30" como empty state. | P3 |
| `app/(app)/ajustes/page.tsx:356-366`, `components/whatsapp/wa-esperando.tsx:123-133`, `doctores/[id]/page.tsx:415` | Copy con fechas de estado operativo ("desde el 22/8", "foto del 7/8", "análisis 7/8") escrito en el código: se va a quedar viejo el día que Periskope responda. → leer de `sync_runs`/`wa_conversations.max(last_message_at)` y redactar dinámico. | P2 |
| `app/login/page.tsx:56` | "Pedile una cuenta a Pancho". | P3 |
| `app/(app)/eventos/page.tsx:78,102`, `components/ajustes/allowlist-manager.tsx:83`, `components/doctor/quick-actions.tsx:563,575` | Placeholders con nombres reales ("Rocío", "Sofia Flores / Lorena Ruiz / Benjamin Navarro", "reemplazo de Itzel", "gabyortho" = handle real de una KOL). | P3 |
| Umbrales dispersos | `seguimiento:35-39` (7/14/90 d), `board.tsx:394` (>10 d estancada), `journey-board.tsx:276-277` (30 d / 14 d), `reportes:566` (30 d enfriándose), `reportes:1064` (45 d opps viejas), `hoy:108` (5 por motor), `panel:613` (6 por franja), `pendientes-card.tsx:41` (3 hechos), `automation_rules.params` en DB (30 d sin contacto, 14 d prospecto, 1,25×/2× ritmo). El mismo concepto ("estancado") tiene 4 números distintos. → `lib/umbrales.ts` o leerlos de `automation_rules`. | P2 |
| Colores de marca `#001d57` / `#cbf2fe` inline | `format.ts:49,90`, `dashboard:521`, `prospeccion:309,315`, `reportes:644,653`, `equipo/actividad:26`, `agent-badge.tsx:25`, `login:13` → tokens CSS (`--brand`, `--brand-soft`). | P3 |
| `app/(app)/herramientas/page.tsx:76-81,180` | Precios MXN y de acreditación en JSX (la página avisa que hay que verificar vigencia). Aceptable para un playbook estático. | P3 |

### 2.6 Fallbacks peligrosos, casts, non-null

- **`?? 0` que esconde errores** — `dashboard/page.tsx:197-249`: 20 counts sin leer `error`; si RLS, timeout o una columna renombrada falla, el tile muestra 0 y el funnel 0% sin aviso. Mismo patrón en `prospeccion:160-187`, `equipo:104-135`, `hoy:230-233,342`. Comparar con `/doctores:202-205` y `/pipeline:223-226`, que sí muestran el error. **P1**.
- `components/pipeline/board.tsx:465` `opp.probability ?? 0` → muestra "0%" para una oportunidad sin probabilidad cargada (distinto de 0). P3.
- `as unknown as`: 29 ocurrencias (`panel` 6, `pipeline` 4, `hoy` 4, `seguimiento` 3, `prospeccion` 2, `search.ts` 2, y 1 en dashboard, casos, eventos, reportes, agenda-brief, paginar, calendar-sync, morning-brief). Causa raíz: el cliente Supabase no está tipado con `Database` (`lib/supabase/server.ts:6`), así que cada select con join es `any` y se castea a mano. → `supabase gen types` + `createServerClient<Database>` elimina casi todos. **P2**.
- `user!.id`: `hoy:89,117,177,205,218`, `panel:123,126,296`, `ajustes:77`, `calidad:72`. El layout ya redirigió si no hay user, así que no explota; pero es una promesa implícita entre archivos. → `requireUser()` en `lib/supabase/server.ts` con `cache()`. P3.
- `process.env.X!` en `lib/supabase/{server,client}.ts` y `proxy.ts:8-9`: sin la env la app arranca y falla en la primera request con un error críptico. → `lib/env.ts` que valide al boot. P3.
- `Map.get(x)!.push` en `panel:346`, `lib/agenda-brief.ts:98`: inofensivo (recién seteado), P3.

### 2.7 Errores tragados, `throw`, try/catch

**Server actions que devuelven `Promise<void>` y tragan el error** (la UI no recibe nada; el usuario aprieta y no pasa nada):
- `lib/actions/alerts.ts:6-36` `resolveAlert`, `dismissAlert` (usadas en `hoy:566-577`). **P1**: un VIEWER, un token vencido o una alerta ya resuelta = click sin feedback.
- `lib/actions/admin.ts:25-91` `recalcularScores`, `ejecutarAutomatizaciones`, `purgarDemo`, `toggleRegla`, `guardarObjetivo` (usadas en `ajustes:188-330`). **P2**: "Recalcular scores" puede fallar (`recompute_all` tarda; timeout) y la pantalla dice nada.
- `lib/actions/quality.ts:71,111,161` `classifyCaseSubject`, `classifyActivity`, `reviewServiceAlert` (usadas en `case-subject-review.tsx:119`, `activity-review.tsx:104`, `calidad:267`). **P2**: el comentario del archivo (20-22) lo reconoce como decisión.
- Además, dentro de acciones que sí devuelven `{error}`: `activities.ts:29-32` y `tasks.ts:59-72` ignoran el error del `update doctors.last_contact_at` y del `insert activities` (P3); `journey.ts:183-202` ignora errores al cerrar tareas de captación (P3).

**Server actions que hacen `throw`** (Next muestra el error boundary genérico y se pierde el formulario):
- `lib/actions/events.ts:62,66,81,98,108` `crearEvento`, `borrarEvento` (usadas en `eventos:52,197`). **P1**: un VIEWER que aprieta "Guardar evento" o "Borrar evento" rompe la página; un nombre con error también. `actualizarNotasEvento` (142-175) del mismo archivo ya hace lo correcto y lo explica en 137-140.
- `lib/actions/team.ts:29,37,41,62,67` `guardarMetasComercial` (usada en `equipo:271`). **P2**.

**try/catch**: no hay `catch {}` que oculte errores de negocio en la UI. Los de `morning-brief.tsx:61`, `ask-crm.tsx:64`, `analyze-button.tsx:38`, `recommendation-card.tsx:114` muestran toast. `lib/noloco-pais.ts:207-209` devuelve el memo viejo o null sin registrar nada (P3: si Noloco falla un mes, nadie se entera).

### 2.8 `revalidatePath` faltante o excesivo

Faltantes (la pantalla queda vieja hasta la próxima navegación dura):
- `activities.ts:34-36` `logActivity`: no revalida `/hoy` (tile "Contactos del mes", 342) ni `/equipo` ni `/equipo/actividad` (el feed que Pancho mira). **P2**.
- `tasks.ts:6-10` `revalidateTaskPaths`: no revalida `/panel` (la agenda del panel lista tareas, 153-163). **P2**.
- `opportunities.ts:26-30` `revalidateOppPaths`: no revalida `/doctores/[id]` (tab Oportunidades) ni `/seguimiento` (si la etapa es `viabilidad`). `createOpportunity` (54-55) tampoco `/seguimiento`. **P2**.
- `viabilidad.ts:57-58` y `whatsapp.ts:37-40` revalidan `"/doctores"` (la **lista**, que no muestra ni viabilidades ni chats) en vez de `"/doctores/[id]"`. P3.
- `doctors.ts:30-31` `updateDoctorContact`: no revalida `/hoy`/`/panel` (ahí se dibujan los botones wa/tel con el teléfono). P3.

Excesivos:
- `admin.ts:30,38,46` `revalidatePath("/", "layout")` en 3 acciones: tira toda la caché. Aceptable tras `recompute_all`; innecesario para `purgarDemo`. P3.
- `journey.ts:7-16` 7 rutas por cada arrastre de tarjeta. Barato pero indica que falta un `revalidateTag("doctor:{id}")`. P3.
- `recommendation-card.tsx:89,103` `router.refresh()` **además** de `revalidateAiPaths()` en la acción → doble render. P3.

### 2.9 `useTransition`, optimistic, renders, requests duplicados

- `components/pendientes/pendientes-card.tsx:56,102-112`: tachar/destachar/borrar comparten el `pending` del botón "Agregar" → el spinner aparece en "Agregar" cuando tildás un renglón. La corrección sí tiene su transición aparte (85). P3.
- `components/whatsapp/wa-esperando.tsx:98` y `journey-board.tsx:97`: ignoran `isPending`; wa-esperando reimplementa el spinner con `corriendo` (96). En journey-board no hay ningún feedback mientras el drag persiste. P3.
- `components/pipeline/board.tsx:147-159` `submitLost`: saca la tarjeta del estado local después del OK; bien. `applyStage` (117-137) hace rollback; bien.
- `components/tasks/task-list.tsx:145-147`: el error de "cancelar" solo se ve si el diálogo de completar está cerrado. P3.
- `components/ai/morning-brief.tsx:43-70`: fetch cliente a `/api/ai/brief` en cada montaje de /hoy (waterfall SSR → cliente). Se puede leer en el server y pasar por prop; el POST sigue en cliente. P3.
- `components/command-palette.tsx:147-161` `SearchButton` dispara un `KeyboardEvent` sintético para abrir el palette. Frágil; un `useCommandPalette()` con contexto lo evita. P3.
- 4 `<Toaster>` montados: `board.tsx:172`, `journey-board.tsx:153`, `doctor-ai-panel.tsx:127`, `morning-brief.tsx:103`. En /hoy conviven 1, en /doctores/[id] 1, en /pipeline 1 o 2 (board + journey no coinciden). Mover uno solo a `app/(app)/layout.tsx`. P2.
- **Auth 3 veces por navegación**: `proxy.ts:31` `getUser()` (llamada de red a Supabase Auth) + `layout.tsx:16` + cada page (`hoy:84`, `panel:98`, `tareas:17`, `equipo:96`, `calidad:68`, `ajustes:73`, `eventos:34`, `doctores/[id]:153`). → envolver `createClient()`/`getUser()` con React `cache()`. P2 (latencia).
- `layout.tsx:22-25` `touch_last_seen` RPC en cada carga (la función frena a los 5 min, pero la llamada viaja igual). P3.
- `doctor-ai-panel.tsx:60-64` re-consulta `doctors` que la página ya cargó. P3.
- `/hoy:109-128` 8 queries para 4 motores (data + count) y `/prospeccion:111-132` 20 queries para 10 etapas → un RPC por pantalla. P3.

### 2.10 Límite de 1.000 filas de PostgREST

| Dónde | Riesgo | Sev |
|---|---|---|
| `app/(app)/tareas/page.tsx:33` `doctors.select("id, nombre, is_accredited")` sin `range` | Con 6.4k+ doctores solo llegan 1.000. Las tareas de los demás caen en "Sin doctor" y sin nombre. El comentario dice "cero consultas extra" y es exactamente el bug que `lib/supabase/fetch-all.ts:4-8` describe. Fix: join `tasks.select("*, doctors(id, nombre, is_accredited)")`. | **P1** |
| `lib/supabase/fetch-all.ts:13-26` sin `ORDER BY` en ninguna llamada (`reportes:94-114,913-931,1013-1045`, `equipo:36-83`, `events.ts:89-91`) | Postgres no garantiza orden estable con `range` sin `order`; `lib/paginar.ts:23-26` lo advierte y lo resuelve, `fetchAllRows` no. Filas duplicadas o salteadas en reportes de producción, actividad y calidad. Fix: `fetchAllRows` exige `orderBy` o lo aplica por `id`. | **P1** |
| `app/(app)/prospeccion/page.tsx:85-88` `accreditedYearRaw` sin `range` | Acreditados del año; hoy <1.000 pero la página presume "MILES de doctores" (65-66). | P2 |
| `app/(app)/reportes/page.tsx:446-452` `docs` (acreditados) sin `range` | Cohortes y calidad por asesor se calculan sobre 1.000 como máximo. | P2 |
| `app/(app)/equipo/actividad/calendario/page.tsx:38` → `lib/actividad-equipo.ts:100-141` sin `range` para un mes entero | `audit_log` de un mes (una fila por campo cambiado) puede superar 1.000. | P2 |
| `app/(app)/dashboard/page.tsx:185-189` `daysToFirstRaw .limit(1000)` sin `is_demo` | Mediana sobre un subconjunto arbitrario. | P2 |
| `app/(app)/panel/page.tsx:145-152` `activities .limit(1000)` | Una persona con >1.000 actividades/mes es improbable; sin aviso igual. | P3 |
| `app/(app)/pipeline/page.tsx:53-57`, `equipo:42-52`, `reportes:754-758`, `eventos:27-33`, `seguimiento:103-130` | Sin `range`; volúmenes chicos hoy. Anotar `// <1.000 por diseño` o usar `fetchAllRows`. | P3 |

### 2.11 Bugs puntuales

- `app/(app)/casos/page.tsx:61-64,140-141` — criterio de "video pendiente" contradice `/seguimiento:23-27` (que usa `video_stage`). **P1** (dos verdades).
- `app/(app)/hoy/page.tsx:117` y `panel:255` — "Míos" y "chats de mis doctores" filtran por `owner_id`; Rocío (CLINICAL) figura en `clinical_owner_id`. Si su cartera del 23/8 se cargó como `owner_id` funciona; si no, "Míos" le muestra vacío. Verificar en datos. **P2**.
- `components/doctor/quick-actions.tsx:306` `text-amber-200` sobre `bg-amber-500/10` y `components/pipeline/board.tsx:417` `text-amber-300`: texto claro sobre fondo claro en modo light → ilegible. P2.
- `components/doctor/timeline.tsx:45-56` `ICONS` no tiene `videollamada` (tipo válido desde 0038) → cae en `StickyNote`. P3.
- `app/(app)/doctores/[id]/page.tsx:227-232` `AUDIT_FIELD_LABELS` no tiene `acquisition_stage`, `activation_stage`, `accredited_at` → en el timeline sale "acquisition_stage: contactado → calificado" crudo (`lib/actividad-equipo.ts:36-50` sí los traduce). P3.
- `app/(app)/ajustes/page.tsx:169` `thisMonth = new Date().toISOString().slice(0, 7)` es el mes UTC, contra la regla de `lib/dates.ts:1-5`. P3.
- `app/(app)/hoy/page.tsx:184-191,257-263` — orden después del `limit(60)` (ver mapa). P2.
- `app/(app)/prospeccion/page.tsx` — sin `is_demo` en ninguna query mientras `/dashboard` filtra: "Prospectos activos" difiere entre las dos pantallas. P2.
- `lib/actions/journey.ts:54-98` `createProspect` no corta si no hay sesión: inserta con `owner_id: null` (90). P2.
- `app/(app)/equipo/page.tsx:88-99` tres awaits en serie que podían ir en el `Promise.all` de arriba. P3.
- `app/(app)/reportes/page.tsx:446-455` dos awaits en serie. P3.
- `components/prospecting/journey-board.tsx:136,138` toasts con emoji (política del equipo: sin emojis en UI). P3.

---

## 3. Permisos: UI vs backend

Contexto: RLS con `can_write()` = todo rol salvo VIEWER (`0004_rls.sql:43-46`); `is_manager()` para ADMIN/COUNTRY_MANAGER/SALES_MANAGER. La app confía en RLS y detecta el rechazo con `.select("id")` → 0 filas (patrón correcto y documentado en `lib/actions/doctors.ts`).

| Dónde | Problema | Sev |
|---|---|---|
| `hoy/page.tsx:566-577` ✓/✕ de alertas | Se muestran a VIEWER; la acción (`alerts.ts:20-25`) traga el rechazo. Click sin efecto ni mensaje. | **P1** |
| `eventos/page.tsx:48-118` "Registrar evento" y `:197-205` "Borrar evento" | Visibles para todos. `crearEvento` hace `throw` con VIEWER (RLS 42501) → error boundary. `borrarEvento` con no-dueño: `delete` con RLS devuelve 0 filas sin error → el botón "funciona" y no borra nada. Las notas sí se gatean por `esMio` (136). | **P1** |
| `doctores/[id]` `QuickActions` (todos los botones) | Un VIEWER ve Actividad/Tarea/Acreditar/Oportunidad/Editar; cada acción devuelve "tu rol no tiene permisos" recién al guardar. Debería ocultarse por rol (el layout ya tiene `profile.rol`). | P2 |
| `prospeccion/page.tsx:265` `NewProspectDialog`, `seguimiento:526` `RegistrarViabilidad`, `doctores/[id]:582` `ObservacionesCard`, `ProspectProfileCard` | Igual: visibles para VIEWER, fallan al guardar. | P2 |
| `ajustes/page.tsx:188-202` | Botones `disabled={!isManager}` y acciones con `managerClient()`: **correcto**, pero las acciones tragan errores (§2.7). | P2 |
| `calidad/page.tsx:74-87` gate por manager en la página; `quality.ts:47-63` gate por "no VIEWER" en la acción | Un SALES podría llamar a la acción (no hay UI que lo haga). Inconsistente pero no explotable. | P3 |
| `equipo/page.tsx:294-314` metas solo manager; `team.ts:36-38` valida | Correcto, salvo el `throw`. | — |
| `components/ajustes/lineas-manager.tsx:85-108` | El select de la línea de **otra** persona se muestra a todos; RLS rechaza y se ve el error. Ocultar salvo propia o manager. | P3 |
| `panel/page.tsx:104-119,682-721` "Ingresos al CRM" | Gate por rol adentro del RPC `team_signins`: correcto. | — |
| `lib/actions/search.ts`, `journey.ts:21-50`, `tasks.ts:92-106`, `doctors.ts:*` | Sin `getUser()`; confían en RLS y detectan 0 filas. Aceptable. | — |
| `lib/actions/ai.ts:36-53` | Gate "no VIEWER" para decidir recomendaciones: correcto. | — |

Conclusión: el backend está bien cerrado; la UI le muestra al VIEWER 20+ controles que no puede usar y en 2 casos lo castiga con una pantalla rota. Un `useRol()`/prop `puedeEscribir` en el layout resuelve el 90%.

---

## 4. Auditoría funcional como CRM

### Recorrido real

**Juan (SALES) abre /hoy a las 9:00.** Ve: saludo, un brief IA vacío si nadie apretó "Generar" (el cron de las 13:00 UTC = 07:00 MX lo genera, bien), agenda si conectó Calendar, 5 tiles del país (no suyos), 20 tarjetas en 4 motores con "por qué" y una frase de acción, su libreta, hasta 8 tareas de hoy/vencidas mezcladas, WhatsApp "esperando" (foto del 7/8), cumpleaños, 8 alertas del país. Para actuar sobre la primera tarjeta tiene que: abrir ficha → WhatsApp (Periskope o wa.me sin mensaje) → volver → "Actividad" → tipo → resumen → guardar. Nada en /hoy le dice "esta oportunidad de $12k lleva 11 días en Presentada" ni "la Dra. X tiene 3 renders sin aprobar hace 20 días" (eso está en /pipeline y /seguimiento). Si contactó a alguien por WhatsApp y no lo registró, el doctor vuelve a aparecer mañana con la misma razón.

**Rocío (CLINICAL) abre /panel.** Ve sus tiles, su agenda de tareas con mini-ficha (esto sí está bien resuelto), reuniones del mes, QuickLog (la forma más rápida de registrar en todo el CRM), su libreta. NO ve: viabilidades esperando respuesta del equipo clínico (su trabajo, en /seguimiento), rechazos de render (en /seguimiento y en Slack), casos de sus doctoras trabados en producción (alertas `caso_atrasado` van a /hoy sin filtro por persona). "Míos" en /hoy filtra `owner_id`, no `clinical_owner_id`.

**Pancho (ADMIN)** tiene /dashboard, /reportes, /equipo, /equipo/actividad, /calidad, /ajustes y el "Ingresos al CRM" adentro del /panel de cada uno. Responde "cómo va el mes" en 3 lugares con los mismos 4 tiles.

### a. Seguimientos: ¿el sistema detecta solo?

Sí, en el backend. `recompute_all` (nightly 05:00 MX) calcula `priority_score/bucket/reasons/recommended_action` por doctor (`0016_scores_v3.sql:204-234, 582-619`) y `evaluate_automations` (cada hora) crea tareas/alertas para 10 reglas (`0006_automations.sql:254-278`): caso atrasado, sin contacto 30 d, oportunidad estancada, acreditado sin activar 30 d, dormido, reactivación, tarea vencida, video sin aprobar 7 d, prospecto sin seguimiento 14 d, viabilidad sin respuesta. Con cupo de 5 tareas/día/persona (0042).

Lo que **no** resuelve la UI:
- **Desde cuándo / responsable**: la tarjeta de /hoy (`hoy:388-467`) muestra nombre, badge de estado, 2 razones y la frase. No muestra `last_contact_at`, `owner`, próxima tarea pendiente ni `expected_next_case_at`. La razón a veces lo dice en texto ("sin contacto en 41 días"), a veces no.
- **Prioridad**: hay `priority_score` y bucket, pero /hoy corta en 5 por motor sin decir el score; no hay "impacto" (casos/mes que representa). `/doctores` ordena por prioridad pero no muestra la razón.
- **Cierre del loop**: la única forma de que un doctor deje de aparecer es registrar una actividad (recalcula `last_contact_at` al vuelo, `activities.ts:29-32`) y esperar el recompute nocturno. No hay "hecho", "posponer 3 días" ni "no aplica" en la tarjeta.
- **Alertas** (`hoy:521-583`): son del país entero, 8 más graves, sin owner, sin acción más que ✓/✕. Un `caso_atrasado` de una doctora de Juan y una `tarea_vencida` de Rocío conviven en la misma lista para ambos.
- **Lo que /seguimiento sabe** (renders 14+, rechazados, viabilidades 14+) **no llega a /hoy** en ninguna forma.

### b. Estados: demasiados y modelados dos veces

Inventario de enums visibles: lifecycle 16 (2 deprecados), acquisition 10, activation 8, opp stage 10, priority bucket 8, forecast 5, task type 7, activity type 9, viability 4, source 14, categoría 6. ≈97 valores.

- **Universo A está modelado dos veces**: `lifecycle_stage` (prospecto/contactado/calificacion/interes_acreditacion/acreditacion_agendada) y `acquisition_stage` (10 valores) dicen lo mismo. La UI solo deja mover `acquisition_stage` (`quick-actions.tsx:61-63`, kanban); el lifecycle se deriva. Dejar lifecycle como **calculado y no editable** y mostrar solo uno de los dos en la ficha (hoy la ficha muestra lifecycle y **no muestra `activation_stage`** en ningún lado: `doctores/[id]:312-320`).
- **Adquisición: 10 columnas** con 6.8k doctores (`prospeccion/lista.tsx:30-35` dice que `accreditation_interest` y `specialty` están en 0 filas). `contacto_intentado` vs `contactado`, `reunion_agendada` vs `reunion_realizada`, `interes_acreditacion` vs `acreditacion_agendada`: distinciones que nadie arrastra a mano. Propuesta: **5 + terminal** — Nuevo · Contactado · Reunión (con fecha) · Acreditación agendada (con fecha) · Acreditado | No interesado (con motivo). Las fechas (`first_contact_at`, `first_meeting_at`, `accreditation_scheduled_at`) ya existen en `Doctor` y son mejor dato que un estado.
- **Activación: 8 columnas manuales** (`journey-board.tsx:71-80`) que duplican las etapas de oportunidad (`paciente_potencial`, `documentacion`, `caso_ingresado`, `planificacion`, `presentado` ≈ `OppStage`). El primer caso lo detecta el sync de Noloco (`first_case_at`, `days_to_first_case`), no un arrastre. Propuesta: **derivar** `activation_stage` de (tiene opp abierta → etapa de la opp; tiene caso → ingresado/pagado) y sacar el kanban de activación; el `MilestoneTrack` (`milestone-track.tsx`) ya es la vista correcta de ese journey.
- **Oportunidades: 8 abiertas + 2 cerradas**, con `forecast_category` y `probability` manuales (`board.tsx:268-331`). Para un pipeline de decenas de opps, `viabilidad → paciente potencial → presentada → decisión → ganada/perdida` alcanza; documentación/caso ingresado/planificación son estados de **producción** que ya vienen de Noloco.
- **Buckets (8) → motores (4)**: ya se colapsan en `hoy:36-66`; `BUCKET_LABELS` es código muerto. Dejar 4.
- `/doctores` filtra por 6 grupos de lifecycle (`doctores:56-73`): esa es la lista de estados que el usuario entiende. Usar esos 6 como labels de cara al usuario.

### c. Próxima acción

- **No existe `doctors.next_action` / `next_action_at`**. Lo más cercano: (1) `recommended_action {type,label}` del motor, texto sin acción; (2) la próxima `task` pendiente (con `due_date`), que **no se muestra** en ninguna tarjeta ni lista (solo en el tab Tareas de la ficha y en /panel); (3) `expected_next_case_at`, calculado y **nunca renderizado**; (4) `activities.next_action` (texto libre, solo lo escribe la IA).
- `recommended_action` se ve en /hoy (`430-434`) y en la ficha ("Motor de reglas sugiere", `doctor-ai-panel.tsx:160-175`). No en `/doctores`, `/prospeccion/lista`, tarjetas kanban ni agenda de /panel. **No hay botón**: ni "crear tarea con esto", ni "abrir WhatsApp con mensaje". La infraestructura existe: `waLink(raw, text)` ya prellena texto en `efemerides-card.tsx:88` y `recommended_action.type` ya dice el canal.
- Las **recomendaciones IA con `suggested_message`** (`recommendation-card.tsx:202-219`) solo aparecen en la ficha, después de que alguien apriete "Analizar con AI" por doctor. El Morning Brief lista `recommendations` (`morning-brief.tsx:176-193`) **sin link al doctor** aunque `AgentRecommendation.doctor_id` existe (`lib/ai/types.ts:376`) y sin botón de aceptar.

### d. Home: ¿bandeja o dashboard?

/hoy es las dos cosas. Bloques y veredicto:

| Bloque en /hoy | Veredicto |
|---|---|
| 5 tiles del país (317-353) | **Sobra** en /hoy (es /dashboard). Para un vendedor lo útil son SUS números (están en /panel). Dejar 1 línea: "Mes: 12/26 pagados · tu parte 5/18". |
| MorningBrief (311) | Queda, pero con links a doctores y "Aceptar" inline; hoy es texto. |
| AgendaHoy (315) | Queda (bien resuelto). |
| "¿A quién contacto hoy?" (356-474) | **Es la bandeja**. Falta: último contacto, owner, próxima tarea, botones Registrar/Posponer/No aplica, mensaje sugerido, filtro "Míos" por defecto para SALES/CLINICAL. |
| Mis pendientes (480-490) | Queda. |
| Tareas de hoy (492-511) | Queda; separar Vencidas de Hoy como /panel (380-382). |
| WA esperando (513-516) | **Sacar hasta que el webhook viva** o marcarlo "histórico" fuera de la columna de trabajo. |
| Efemérides (519) | Queda. |
| Alertas (521-583) | Filtrar por owner del doctor; agregar acción; o fundirlas con las tarjetas (la alerta ES la razón de prioridad). |
| **Falta**: "Necesitan atención" | Renders 14+ (por doctora, con WhatsApp), rechazados sin rehacer, viabilidades 14+, opps estancadas >10 d, tareas vencidas del equipo. Todo existe en /seguimiento y /pipeline; en /hoy no hay ni un contador. |

Solapamientos:
- **/hoy ↔ /panel**: AgendaHoy, PendientesCard, WaEsperandoLista, tareas, tiles. /panel además tiene lo que /hoy debería tener (QuickLog, tareas en 3 franjas, mini-ficha). → **una sola home personal** (`/hoy?u=`), con /panel redirigiendo. "Ingresos al CRM", "Tu mes por tipo" y "Noloco por país" van a /equipo (son de gestión).
- **/dashboard ↔ /reportes**: casos por mes (chart vs tabla), casos por categoría (mes vs 90 d), top doctores (mes vs 90 d), funnel vs cohortes, tiles de forecast (también en /hoy y /pipeline). → /dashboard = foto del mes + funnel + Ask; /reportes = series y cortes. Eliminar de /dashboard las dos tablas (589-673) y de /reportes Producción el "casos por mes" (150-178) dejando el chart en un solo lado.
- **/equipo ↔ /panel ↔ /equipo/actividad ↔ /reportes?t=actividad**: cuatro respuestas a "qué hizo cada uno" con tres ventanas (30 d, mes, 90 d) y dos definiciones de contacto (§2.2).

### e. Historial (timeline de la ficha)

`doctores/[id]/page.tsx:178-258` une: actividades (200), hitos de casos (ingreso/aprobación/finalizado), audit de 4 campos del doctor. Falta:

| Fuente | Dónde está el dato | Cómo se ve hoy |
|---|---|---|
| Tareas creadas / canceladas / vencidas | `tasks` (`created_at`, `status`) | No (las completadas sí, porque `completeTask` inserta una actividad "nota"). |
| Oportunidades creadas / movidas / ganadas / perdidas (con motivo) | `opportunities.created_at`, `audit_log entity_type='opportunity' field='stage'` (`reportes:759-765` ya lo lee) | No (la página filtra `entity_type='doctor'`, 138). |
| Cambios de `acquisition_stage` / `activation_stage` / `accredited_at` | `audit_log` | Sí pero con nombre crudo (§2.11). |
| Recomendaciones IA aceptadas/descartadas | `ai_recommendations.decided_at` | Solo en el panel IA, plegado a 3. |
| Alertas abiertas / resueltas | `alerts` | No. |
| Eventos a los que asistió | `event_attendees` | Solo en el brief de /panel y en `/eventos`. |
| Reuniones de Calendar | `calendar_events` | Solo en la agenda del día. |
| Render enviado / rechazado / aprobado | `cases.fecha_video`, `fecha_rechazado`, `fecha_aprobacion_video`, `video_stage` | No (solo ingreso/aprobación/finalizado). |
| Pagos (primer caso pagado, último) | `first_paid_case_at`, `last_paid_case_at`, ledger | No. |
| Mensajes de WhatsApp | `wa_conversations` (solo último mensaje) | Bloque aparte, no en timeline. |
| Sync de Noloco (contact points, comunicaciones) | Entran como `activities` con `created_by null` | Sí, sin distinguir "lo trajo el sync" de "lo cargó alguien" (el actor queda vacío). |

Y no hay filtro por tipo ni búsqueda dentro del timeline. Propuesta: `lib/timeline-doctor.ts` con el patrón de `lib/actividad-equipo.ts` (un `ItemTimeline {ts, kind, actor, texto, ref}`) y un filtro de 5 chips (Contactos · Casos · Pipeline · Sistema · IA).

### f. Cosas que hoy dependen de que alguien se acuerde (candidatas a automatizar)

Ya automatizado: 10 reglas de `automation_rules`, recompute nocturno, 8 crons de Vercel (`vercel.json`: Noloco c/2 h, actividades diario, alerta de rechazos c/10 min, brief 07:00 MX, asistencia 17:30 MX, render v2 c/2 h, calendar diario, pagos diario).

Depende de memoria humana:
1. **Registrar cada WhatsApp/llamada** — sin eventos de Periskope, `last_contact_at` solo se mueve si alguien carga la actividad. Mitigación sin Periskope: botón "Registrar contacto" de 1 click en la tarjeta (tipo + fecha ahora, resumen opcional).
2. **"Ya respondí"** en la lista de WA (`wa-esperando.tsx:193-226`) sobre una lista congelada.
3. **Cargar la respuesta de una viabilidad** (`registrar-viabilidad.tsx`) — el equipo clínico responde por WhatsApp; nadie lo vuelve a /seguimiento. Regla `viabilidad_sin_respuesta` existe; falta que la tarea sea de Rocío por default (`clinical_owner_id`).
4. **Seguimiento post-KeepDay** (playbook `herramientas:234-241`: "el 70% se cierra después, seguimiento a 48 h no es opcional") — no hay regla que cree la tarea T+1/T+2 al registrar una actividad `keepday`.
5. **Post-evento/congreso**: `event_attendees` sin actividad en 7 días → nada (`reportes:431-434` dice "están en Prospección, listos para trabajar": nadie los lista).
6. **"Nunca salir sin próximo paso"** (playbook `herramientas:132`): completar tarea tiene "Próximo paso (opcional)" (`task-list.tsx:192-218`); registrar actividad no ofrece próximo paso. Una reunión/videollamada registrada sin tarea siguiente debería generar "Definir próximo paso con X" al owner.
7. **Render 14+ días** — solo alerta `aprobacion_pendiente` (7 d) al país; no crea tarea al owner ni sugiere el mensaje a la doctora (`seguimiento:297-310` ya arma el botón WhatsApp sin texto).
8. **Renders rechazados** — llegan a Slack; en el CRM no crean tarea a producción/clínica.
9. **Acreditado sin activar** — regla a 30 d; el playbook habla de "alerta al día 75" y "KeepDay como prioridad 1". Un solo umbral.
10. **Mover el pipeline de activación** a mano cuando Noloco ya trajo el caso.
11. **Clasificar casos/actividades/alertas** en /calidad (la IA lo propone solo si alguien apreta "Analizar").
12. **Cumpleaños** — hay tarjeta con mensaje; no hay tarea ni recordatorio el día.
13. **Forecast/probability de cada opp** — manual (`board.tsx:268-331`); el trigger de DB ajusta al mover etapa.
14. **Reasignar tareas** — imposible desde UI.
15. **Alertas resueltas** — nadie las cierra; /hoy muestra "8 de N" con N en cientos (`hoy:162-165`).

### g. Fricción (clicks / pantallas)

| Acción | Camino más corto hoy | Interacciones | Pantallas |
|---|---|---|---|
| Registrar una llamada a un doctor de /hoy | ficha → Actividad → tipo → resumen → Guardar | 5 | 2 |
| Registrar una llamada desde /panel (QuickLog) | tipear nombre → elegir → tipo → resumen → Registrar | 5 | 1 |
| Crear tarea | ficha → Tarea → título → tipo → fecha → Crear | 6 | 2 (sin asignar a otro, sin hora) |
| Completar tarea (+ próxima) | Completar → resultado → [próximo título/tipo/fecha] → Completar | 3 (6) | 1 |
| Mover prospecto de etapa | kanban: 1 arrastre (solo top-30 por columna) · ficha: Mover etapa → select → Mover (3) | 1–3 | 1–2 |
| Marcar "no interesado" | igual que mover; sin motivo | 1–3 | — |
| Acreditar | ficha → Acreditar → nota → Acreditar | 3 | 2 |
| Marcar WA respondido | 1 click (sobre datos viejos) | 1 | 1 |
| Resolver alerta | 1 click (sin feedback si falla) | 1 | 1 |
| Cargar respuesta de viabilidad | /seguimiento → tab → Registrar → estado → resultado → fecha → Guardar | 6 | 1 |
| Corregir una nota | hover → lápiz → editar → Guardar | 3 | 1 |
| Escribir WhatsApp con mensaje sugerido | no existe (salvo cumpleaños) | — | — |
| Posponer / descartar una prioridad | no existe | — | — |
| Ver la próxima tarea de un doctor desde una lista | no existe (abrir ficha → tab Tareas) | 2 | 2 |

---

## 5. Top 10 mejoras funcionales (impacto / costo)

1. **Tarjeta de prioridad accionable en /hoy** — Hoy: nombre + 2 razones + frase, botones wa/tel/ficha (`hoy:388-467`). Propuesta: mostrar último contacto, owner, próxima tarea y `expected_next_case_at`; botones **Registrar contacto** (popover: tipo preseleccionado por `recommended_action.type`, resumen opcional, guarda `logActivity`), **WhatsApp con mensaje** (`waLink(phone, plantilla[recommended_action.code])`, Periskope si hay chat), **Posponer 3 días** (`createTask` con `due_date`), **No aplica** (activity `nota` "descartado: motivo"). Archivos: nuevo `components/hoy/priority-card.tsx` (client), `lib/plantillas-wa.ts`, `hoy/page.tsx`, reusar `lib/actions/{activities,tasks}.ts`. **Esfuerzo M**. Es la mejora que convierte el CRM en "te dice qué hacer" de verdad.
2. **Sacar la foto vieja de WhatsApp de la columna de trabajo** — Hoy: `WaEsperandoLista` en /hoy y /panel con aviso "foto del 7/8". Propuesta: si `sinDatosFrescos` (`wa-esperando.tsx:104`), no montar el bloque en /hoy y /panel; dejarlo en la ficha del doctor como "último chat conocido (7/8)". Cuando Periskope despache eventos, vuelve solo. Archivos: `wa-esperando.tsx:100-105`. **S**.
3. **Una sola home personal** — Hoy: /hoy (país + mío) y /panel (mío + gestión). Propuesta: /hoy toma de /panel el QuickLog, las tareas en 3 franjas y la mini-ficha; `?u=` para ver la de otro; "Míos" por defecto para SALES/CLINICAL (incluyendo `clinical_owner_id`); /panel redirige. "Ingresos al CRM", "mes por tipo" y "Noloco por país" pasan a /equipo. Archivos: `hoy/page.tsx`, `panel/page.tsx`, `equipo/page.tsx`, `app-sidebar.tsx`. **M**.
4. **Bloque "Necesitan atención" en /hoy** — Hoy: renders 14+, rechazados, viabilidades 14+, opps estancadas y tareas vencidas viven en /seguimiento, /pipeline y /tareas. Propuesta: 5 contadores con link y, para el rol, la lista corta (Rocío: viabilidades y rechazos; Juan: renders de sus doctoras y opps estancadas). Reusar las 3 queries de `seguimiento:103-130` en `lib/queries/seguimiento.ts`. Y `/casos` usa el mismo criterio `video_stage` (P1 de §2.11). **S**.
5. **Timeline unificada del doctor** — Hoy: 3 fuentes (§4e). Propuesta: `lib/timeline-doctor.ts` con tareas (creadas/canceladas/vencidas), opps (audit `entity_type='opportunity'`), recomendaciones IA decididas, alertas, eventos asistidos, Calendar, render enviado/rechazado/aprobado, pagos; labels para `acquisition_stage`/`activation_stage`; actor "Sync Noloco" cuando `created_by null`; 5 chips de filtro. Archivos: `doctores/[id]/page.tsx:178-258`, `components/doctor/timeline.tsx`. **M**.
6. **Tareas: arreglar el cap de 1.000 y permitir asignar** — Hoy: `/tareas:33` trae 1.000 doctores; `createTask` acepta `assigned_to` sin UI. Propuesta: `tasks.select("*, doctors(id, nombre, is_accredited)")`; select "Asignar a" (perfiles activos no VIEWER) en el diálogo de tarea y en el completar→próximo paso; "Reasignar" en `TaskList`. Archivos: `tareas/page.tsx`, `quick-actions.tsx:243-284`, `task-list.tsx`, `tasks.ts`. **S**.
7. **Simplificar estados** — Hoy: 10 acq + 8 act + 16 lifecycle + 8 buckets. Propuesta (fase UI, sin migración): kanban de adquisición con 5 columnas (mapeo 10→5 en `lib/etapas.ts`, el select "Mover etapa" ofrece 5, la DB sigue guardando el valor fino); sacar el kanban de activación y dejar `MilestoneTrack` + opps; ocultar buckets. Fase DB (después): colapsar enums y hacer `lifecycle_stage` solo-lectura para la app. Archivos: `journey-board.tsx`, `prospeccion/page.tsx`, `prospeccion/lista/page.tsx`, `quick-actions.tsx:61-63`, `pipeline/page.tsx:73-88`, `types.ts`. **M** (UI) / **L** (DB).
8. **Que ningún click falle en silencio** — Hoy: 11 acciones `void` + 2 con `throw` (§2.7), 4 `<Toaster>`. Propuesta: todas devuelven `{error}|{ok}`; formularios de RSC pasan a `useActionState` o a un `<FormAccion>` cliente chico que muestre el toast; un `<Toaster>` en `app/(app)/layout.tsx`; botones ocultos por rol con `profile.rol` desde el layout (contexto `RolProvider`). Archivos: `alerts.ts`, `admin.ts`, `quality.ts`, `team.ts`, `events.ts`, `hoy:566-577`, `ajustes:188-330`, `calidad:267-322`, `eventos:52,197`, `equipo:271`, `quick-actions.tsx`. **S-M**.
9. **Automatizaciones que faltan** (todas en `automation_rules` + `evaluate_automations`, patrón ya existente): (a) actividad `keepday` → tarea "Seguimiento post-KeepDay" T+2 al owner; (b) `event_attendees` sin actividad en 7 d → tarea "Contactar tras {evento}"; (c) `reunion`/`videollamada` registrada sin tarea pendiente → tarea "Definir próximo paso"; (d) render 14+ → tarea al owner con el mensaje a la doctora; (e) rechazo de render → tarea a `clinical_owner_id`; (f) `viabilidad_sin_respuesta` asignada a `clinical_owner_id`. Archivos: nueva migración `0052_automatizaciones_playbook.sql`; `task-list.tsx` para que "próximo paso" sea sugerido por defecto. **M**.
10. **Base técnica que evita que los números mientan** — (a) tipos generados de Supabase (`Database` en `lib/supabase/{server,client}.ts`) y borrar los 29 `as unknown as`; (b) `fetchAllRows` con `order` obligatorio (`fetch-all.ts:13-26`) y unificar con `traerTodo`; (c) leer `error` en `/dashboard`, `/prospeccion`, `/equipo`, `/hoy` y mostrar "sin dato" en vez de 0; (d) `is_demo` en `prospeccion:75-133` y `dashboard:148-152,185-189`; (e) un solo `CONTACTO_TYPES`/definición de videollamada (`equipo:146-164`); (f) `lib/roles.ts`, `lib/dates.ts` ampliado, `lib/limites.ts`, `ui/native-select.tsx`, `components/kpi-tiles.tsx`, `components/doctor/contact-buttons.tsx`; (g) `cache()` para `getUser`/`profile`/`profiles`; (h) `profiles.noloco_v2_user_id` y `profiles.slack_user_id` en vez de mapas por nombre. **M**.

Extras de una línea (no ejecutar sin pedido): `/doctores` y `/prospeccion/lista` con columnas Owner · Último contacto · Próxima tarea · Acción sugerida; morning brief con links y "Aceptar"; `expected_next_case_at` como "le toca el 12/9" en ficha y lista; command palette leyendo `NAV` del sidebar; mover `/equipo/actividad` al sidebar bajo Equipo.

---

## Apéndice: índice de hallazgos por severidad

**P0**
- Lista "WhatsApp esperando respuesta" congelada desde el 7/8 en la columna de trabajo de /hoy y /panel (`wa-esperando.tsx:104,123-133`; `hoy:513-516`; `panel:752-756`).

**P1**
- `/tareas:33` doctores sin paginar → tareas sin nombre en "Sin doctor".
- `fetchAllRows` sin ORDER BY (`fetch-all.ts:13-26`; usos en `reportes`, `equipo`, `events.ts`).
- `/dashboard:101-249`, `/prospeccion:75-187`, `/equipo:23-135`, `/hoy:230-233` no leen `error`: fallas = 0.
- `/casos:61-64,140-141` criterio de render contradictorio con `/seguimiento:23-27`.
- "Contactos" con dos definiciones (`equipo:146-164` vs `actividad-equipo.ts:27-34`, `hoy:198`, `panel:198`).
- `alerts.ts:6-36` void + `hoy:566-577` visible a VIEWER: click sin efecto.
- `events.ts:62-108` `throw` + `eventos:52,197` visibles a todos: pantalla rota / borrar que no borra.
- `noloco-pais.ts:24-28` mapeo persona→Noloco por primer nombre.
- Timeline no unificada (`doctores/[id]:178-258`) — funcional.
- `recommended_action` sin acción y `expected_next_case_at` nunca mostrado — funcional.
- Universo A modelado dos veces (lifecycle + acquisition) y activation manual duplicando opps — funcional.

**P2**
- 29 `as unknown as` por cliente sin tipar; `admin.ts`/`quality.ts` void; `team.ts` throw; 4 Toasters; auth 3× por navegación; revalidaciones faltantes (`activities.ts`, `tasks.ts`, `opportunities.ts`); `/prospeccion` sin `is_demo`; `/hoy` sort tras `limit(60)`; "Míos" por `owner_id`; calendario mensual sin `range`; `createProspect` sin sesión; contraste `text-amber-200/300`; command palette desincronizado; hardcodes de Periskope/Slack/copy con fechas; umbrales dispersos; botones de escritura visibles a VIEWER; no se puede asignar tarea a otro.

**P3**
- `ComingSoon`, `BUCKET_LABELS`, rama `next_action` de `classifyActivity`; 8 `selectClass`; `median`/`monthKey`/`norm`/`ACQ_RANK`/`LOST_REASONS`/`MAX_*` duplicados; 6 reimplementaciones de "hoy MX"; `ICONS` sin `videollamada`; `AUDIT_FIELD_LABELS` incompleto; `ajustes:169` mes UTC; `probability ?? 0`; `router.refresh` + revalidate; `SearchButton` sintético; `pendientes-card` sobredimensionada; placeholders con nombres reales; emojis en toasts; awaits en serie en `/equipo` y `/reportes`; `revalidatePath("/", "layout")`; `process.env!`.

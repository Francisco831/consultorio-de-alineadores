# Auditoría de base de datos — CRM MX (Supabase/Postgres)

Fecha: 2026-09-02. Alcance: lectura de `supabase/migrations/0001..0051`, `supabase/rollbacks/*`,
`supabase/environments.json`, `supabase/HOTFIX_LOG.md`, `scripts/db-migrate.ts`,
`scripts/lib/{migrate-core,pg,destino}.ts`, `scripts/backup-datos.ts`, `lib/types.ts`,
`docs/OPERACION.md`, más grep de `app/`, `components/`, `lib/`, `scripts/` para saber qué usa
la aplicación. No se tocó ninguna base ni ningún archivo del repo. Rutas relativas a
`/Users/franciscobasilico/dev/Periskope/crm-mx/`.

Severidades: **P0** = pérdida de datos/negocio posible hoy · **P1** = corregir esta
semana · **P2** = deuda que ya muerde o va a morder · **P3** = limpieza.

---

## 0. Hallazgos priorizados (índice)

| # | Sev | Hallazgo | Dónde |
|---|-----|----------|-------|
| 1 | **P0** | Producción sin respaldo automático ni restore probado; el único volcado es manual, omite `auth.users`/`ops`/`cron.job` y no existe cargador para restaurarlo | `scripts/backup-datos.ts:7-17`, `docs/OPERACION.md:169-172` |
| 2 | **P1** | `doctors.is_demo` (y el de `opportunities`, `tasks`, `contacts`) lo escribe cualquier no-VIEWER: `purge_demo()` borra en cascada al doctor y toda su historia | `0019_fixes_auditoria.sql:682-721` (guard no cubre `is_demo`), `0006_automations.sql:281-296` |
| 3 | **P1** | El runner no anota los rollbacks: tras correr uno, el ledger sigue diciendo "aplicada" y `--apply` nunca la re-aplica | `scripts/db-migrate.ts:472-474,514-517,566`, `scripts/lib/migrate-core.ts:177-186` |
| 4 | **P1** | `lifecycle_stage`, `acquisition_stage`, `activation_stage`, `last_contact_at`, `tags`, `source` los escribe cualquier no-VIEWER por PATCH directo, sin pasar por el journey ni por recompute | `0019:682-721`, `0004_rls.sql:48-67` |
| 5 | **P1** | `tasks` no tiene guard: cualquier no-VIEWER reasigna, cambia `due_date`, `completed_at`, `created_by`, `automation_rule_id` de cualquiera (KPI y cupo manipulables) | `0004_rls.sql:51-66`, `0003_triggers_audit.sql:202-227` |
| 6 | **P2** | Dos escritores del lifecycle con umbrales distintos: `recompute_doctor` (0019) y `evaluate_automations` (0047 — reglas `dormido_detectado`, `reactivacion`, `acreditado_no_activado`) | `0019:285-333`, `0047:128-217` |
| 7 | **P2** | Cambios de lifecycle hechos por `recompute_doctor` bajo sesión de usuario quedan auditados con `actor_id = usuario` y `source = 'app'`, y `/equipo/actividad` los cuenta como trabajo de la persona | `0003:21-30` (log_audit), `0019:65`, `lib/actividad-equipo.ts:135-138` |
| 8 | **P2** | Render/viabilidad (0043-0047) generan alertas pero NO entran en `priority_reasons`/`recommended_action`: el motor de /hoy no los ve | `0019:428-599` vs `0047:244-305` |
| 9 | **P2** | Cupo de tareas (0042) se saltea cuando `assigned_to` es null; con 2+ SALES activos `default_sales_owner()` devuelve null y vuelve la avalancha | `0042:70-73`, `0021:11-18` |
| 10 | **P2** | Sin `deleted_at`/`merged_into` en `doctors`: 4 scripts borran físicamente; un acreditado borrado vuelve en el próximo sync de Noloco sin historia | `scripts/merge-prospect-dups.ts:111`, `scripts/limpiar-basura.ts:87`, `lib/noloco-sync.ts:406-418` |
| 11 | **P2** | `events_delete`, `event_attendees_delete`, `calendar_events_*` abiertas a cualquier no-VIEWER (0051 cerró el UPDATE de events al autor, no el DELETE) | `0035_events.sql:39,43`, `0046_calendar.sql:66-74` |
| 12 | **P2** | Rollback 0043 contiene `\echo` (psql): falla bajo node-pg. Rollback 0033 devuelve EXECUTE a PUBLIC, contra la regla del proyecto | `rollbacks/0043_…:7`, `rollbacks/0033_…:4`, `docs/OPERACION.md:122` |
| 13 | **P2** | Migraciones con efectos de negocio (crean alertas/tareas, resuelven alertas, cancelan tareas): 0020, 0042, 0043, 0044, 0047 | `0044:328-333`, `0047:22,344-355`, `0042:45-50`, `0020:18-23` |
| 14 | **P2** | `score_snapshots`: 1 fila/doctor/día (≈7k/día, 2,5M/año) escrita cada noche y nunca leída | `0005_scores.sql:405-412` |
| 15 | **P2** | Cambios de `profiles.rol` no se auditan; `automation_rules.params` y `commercial_offers` tampoco | `0004_rls.sql:112-124` |
| 16 | **P2** | Índices faltantes: `cases(id_externo)`, `alerts(doctor_id) where abierta`, `audit_log(actor_id, created_at)`, `activities(sync_key)`; sin unique en `cases.id_externo` ni en `event_attendees(event_id, doctor_id)`; teléfono de doctor sin normalizar ni indexar | ver §6 |
| 17 | **P2** | `recompute_all` es O(N·M): por cada uno de los 7k doctores recalcula el p90 de TODAS las oportunidades; ya corta por timeout vía PostgREST | `0019:356-362`, `lib/noloco-sync.ts:485-488` |
| 18 | **P3** | Objetos muertos: `segments`, `saved_views`, `custom_field_defs`, `wa_messages`, `profiles.whatsapp_phone/avatar_url`, `cases.needs_review`, `ai_second_case_metrics()`, bucket `alto_impacto`, lifecycle `growth` (nunca asignado), 2 valores deprecados del enum | ver §2 |
| 19 | **P3** | Docs desactualizadas: `OPERACION.md:8-9` (misma región) vs `environments.json:4` (prod en us-east-2); `pg.ts:13`; `OPERACION.md:176` ("no hay despliegue") | — |
| 20 | **P3** | Pseudo-enums sin CHECK: `goals.metric`, `events.tipo`, `sync_runs.status/source`, `wa_conversations.asignado` | `0002:319,364-371`, `0035:13` |

---

## 1. Schema final efectivo (después de 0051)

32 tablas en `public` + 2 en `ops`. Los números entre paréntesis son la migración que crea/altera.

### 1.1 Tablas

| Tabla | Propósito | Columnas clave (tipo/estado) |
|---|---|---|
| `profiles` (0002, 0041, 0050) | 1:1 con `auth.users`; rol y presencia | `rol user_role`, `activo`, `periskope_org_phone` (CHECK 11-15 dígitos), `last_seen_at`; `whatsapp_phone`, `avatar_url` **sin uso** |
| `doctors` (0002, 0015, 0036, 0040, 0048, 0049) | Centro del sistema; dos universos | Identidad: `noloco_id` UNIQUE, `nombre`, `email`, `phone`, `whatsapp`, `instagram` (CHECK formato + unique parcial), `facebook/tiktok/linkedin/website`, `birth_date` (CHECK rango), `state` (32 entidades, sin CHECK), `zona` (CHECK 6 valores), `city`, `observaciones`. Universo: `is_accredited bool NOT NULL`, `acquisition_stage acq_stage`, `activation_stage act_stage`, `lifecycle_stage NOT NULL default 'prospecto'`, `accredited_at`, `first_paid_case_at`, `last_paid_case_at`, `days_to_first_case`, `activated_by`, `reactivated_at`, `lost_reason`. Perfil prospecto: `specialty`, `uses_aligners`, `estimated_cases_month`, `interest_level` (1-5), `accreditation_interest` (1-5), `why_interesting`. Gestión: `owner_id`, `clinical_owner_id`, `categoria`, `potential_override`, `tags[]`, `competitor_brands[]`, `custom jsonb` (solo `estado_crudo` de 0049), `source`, `campaign_id`. Cache de score (solo sistema): `health_score`, `health_factors`, `health_confidence`, `potential_computed`, `priority_score`, `priority_reasons`, `priority_bucket` (CHECK 8), `recommended_action {type,label}`, `avg_interval_days`, `expected_next_case_at`, `case_count`, `new_case_count`, `first/last_case_at`, `last_new_case_at`, `last_contact_at`, `first_contact_at`, `first_meeting_at`. `is_demo`. |
| `cases` (0002, 0013, 0022, 0045) | Espejo de Noloco (xanoCasos) + espejo v2 del render | `noloco_case_id` UNIQUE, `id_externo` (sin índice), `doctor_id` FK, `paciente`, `etapa`, `is_new_case` (= etapa `I_1`, la regla del KPI), `treatment_key`, `tipo_caso`, `alineadores_total`, `entregas`, 10 `fecha_*`, `case_subject_type` (CHECK 4, default UNKNOWN) + `_source/_set_by/_set_at`, `video_stage`, `video_sub_stage`, `video_estado`, `fecha_rechazado`, `video_v2_synced_at` |
| `payments` (0002) | Verdad del "caso pagado" (planilla) | `doctor_id` FK nullable, `case_id`, `paid_at`, `amount_mxn`, `external_key` UNIQUE, `source` |
| `opportunities` (0002, 0010-0012, 0022) | Pipeline por paciente | `stage opp_stage`, `stage_entered_at`, `probability`, `forecast_category`, `amount_mxn`, `owner_id`, `case_id`, `external_key` UNIQUE, `closed_at`, `lost_reason`; ciclo viabilidad: `viability_status` (CHECK 4), `viability_result`, `viability_requested_at/submitted_at/completed_at`, `viability_clinical_owner`, `viability_follow_up_date` |
| `automation_rules` (0002) | Reglas del evaluador; umbrales en `params` | `key` UNIQUE, `enabled`, `params jsonb`, `creates_task`, `task_type`, `last_run_at`, `run_stats` |
| `alerts` (0002, 0022) | Salida del evaluador | `rule_key` (texto, sin FK), `doctor_id`, `opportunity_id`, `severity`, `status`, `resolved_by/at`, `service_confidence` (CHECK 3), `trust_risk_score` (0-100), `impact_factors`; dedupe por índices únicos parciales (0002:218-221) |
| `tasks` (0002) | Cola comercial | `doctor_id`, `opportunity_id`, `type task_type`, `status task_status`, `due_date`, `outcome`, `completed_at`, `assigned_to`, `created_by`, `automation_rule_id` (marca de tarea automática), `alert_id` |
| `activities` (0002, 0022, 0051) | Timeline/notas | `type activity_type`, `occurred_at`, `summary`, `outcome`, `created_by`, `engagement_quality` (CHECK 3) + `_source/_set_by/_set_at`, `main_topic`, `next_action`, `edited_at`, `edited_by`, `sync_key` (huella congelada del cron) |
| `audit_log` (0002) | Historial append-only | `entity_type`, `entity_id`, `field`, `old/new_value`, `actor_id` (null = sistema), `source` ('app' default / 'automation' / 'migracion_0042') |
| `score_snapshots` (0002) | 1 fila/doctor/día | UNIQUE (doctor_id, snapshot_date). **Nunca se lee.** |
| `cohort_intervals` (0005) | Mediana de ritmo por categoría | PK `categoria`. Solo la usa SQL. |
| `wa_conversations` (0002, 0009, 0041) | Metadata de chats Periskope | `periskope_chat_id` UNIQUE, `doctor_id`, `phone` (nullable), `chat_name`, `lineas[]`, `asignado`, `activity_bucket` (CHECK 3), `unanswered`, `last_message_at/body/from_me`, `respondido_at/por` |
| `wa_messages` (0002) | Cuerpos de mensajes | **Nunca escrita** (el webhook solo toca `wa_conversations`). |
| `sync_runs` (0002) | Log de crons/imports | `source` (texto libre: noloco, render-v2, planilla_pagos, asistencia, alerta-rechazos, calendar, actividades, ledger_reconcile, import), `status` (running/ok/error/"estado"), `watermark`, `log` |
| `ai_recommendations` (0017, 0022, 0026) | HITL: la IA propone, el humano decide | `agent` (CHECK 9), `status` (CHECK: propuesta/aceptada/descartada/ejecutada/expirada), `payload`, `decided_by/at`, `dismiss_code` (CHECK 8), `bottleneck` (CHECK 21), `owner_role`, `final_action`, `human_edited`, confianzas; dedupe único parcial por (doctor, agent, type) en `propuesta` |
| `doctor_ai_profile` (0017) | Memoria cualitativa 1:1 | `last_source` (humano/ai_confirmado). Sin policy de escritura de cliente. |
| `agent_runs` (0017, 0022, 0026) | Observabilidad IA | tokens, costo, `routing_*`, `trigger` (CHECK 4), `status` (CHECK 3) |
| `agent_handoffs` (0026) | Handoffs entre agentes | Se inserta (`lib/ai/orchestrator.ts:1175`), nunca se lee. |
| `commercial_offers` (0022, 0025) | Condiciones comerciales para la IA | UNIQUE (market, name); CHECK pct/monto; 4 filas seed MX. Sin UI. |
| `campaigns` (0002, 0019) | Eventos/campañas para ROI | `nombre` UNIQUE. Solo `evento_roi()` y 2 scripts. |
| `contacts` (0002) | Personas de la clínica | Se lee en ficha y contexto IA; se escribe solo desde `scripts/import-whatsapp.ts`. |
| `segments`, `saved_views`, `custom_field_defs` (0002) | V1 "no-code" | **Sin ningún uso.** |
| `goals` (0002) | Objetivos mensuales | UNIQUE (period, metric, coalesce(user_id)); `metric` sin CHECK (app escribe `paid_cases`/`accreditations`, el comentario de 0002 lista otros 3) |
| `auth_allowlist` (0031) | Red de altas bajo `disable_signup` | `email` UNIQUE normalizado por trigger, `active`, auditada (incluye DELETE) |
| `events`, `event_attendees` (0035) | Eventos académicos grupales | `tipo` texto libre; `events` **sin `updated_at` ni audit** aunque 0051 permite editar `notas` |
| `alerta_rechazos_estado` (0037) | Estado del cron de rechazos (portal AR) | PK `caso`; RLS sin policies (solo service role) |
| `pendientes` (0039) | Libreta personal | RLS por dueño |
| `calendar_events` (0046) | Espejo de Google Calendar por persona | UNIQUE (profile_id, google_event_id) |
| `ops.schema_migrations` (0028) | Ledger | `filename` PK, `checksum`, `applied_at`, `applied_by` (siempre `postgres`), `duration_ms` |
| `ops.geo_0049_backup` (0049) | Foto de state/zona previa a 0049 | Necesaria para el rollback de 0049 |

### 1.2 Enums (valores finales)

- `doctor_categoria`: SIN_CATEGORIA, SILVER, GOLD, PLATINUM, BLACK, ELITE
- `lifecycle_stage` (16): prospecto, contactado, calificacion, interes_acreditacion, acreditacion_agendada, **acreditacion_pendiente** (deprecado), acreditado, **acreditado_no_activado** (deprecado), en_activacion, activado, activo, growth, en_riesgo, dormido, reactivado, perdido. Nota: `growth` no lo asigna nunca ni recompute ni el evaluador (solo se lee en `in ('activo','growth')`).
- `acq_stage` (10): identificado, contacto_intentado, contactado, calificado, reunion_agendada, reunion_realizada, interes_acreditacion, acreditacion_agendada, acreditado, no_interesado
- `act_stage` (8): acreditado, contactado_post, paciente_potencial, documentacion, caso_ingresado, planificacion, presentado, primer_caso_pagado
- `opp_stage` (10): viabilidad, paciente_potencial, documentacion, caso_ingresado, planificacion, presentada, decision, compromiso, ganada, perdida
- `forecast_cat`: pipeline, best_case, commit, closed, omitted
- `task_type` (7): llamada, videollamada, whatsapp, visita, reunion, revision_clinica, seguimiento
- `task_status`: pendiente, completada, cancelada
- `activity_type` (9): llamada, videollamada, whatsapp, visita, reunion, revision_clinica, email, nota, keepday
- `alert_status`: abierta, descartada, resuelta · `alert_severity`: critica, alta, media, info
- `attribution_source` (14): ventas, clinica, evento, curso, inbound, referido, existente, campana, congreso, instagram, website, universidad, partnership, otro
- `user_role`: ADMIN, COUNTRY_MANAGER, SALES_MANAGER, SALES, CLINICAL, VIEWER
- Pseudo-enums text+CHECK: `priority_bucket` (critico, alto_impacto, seguimientos, oportunidades, riesgo, growth, nuevo_negocio, activacion — `alto_impacto` ya no se produce desde 0016), `health_confidence`, `case_subject_type/source`, `engagement_quality/source`, `service_confidence`, `viability_status`, `ai_recommendations.status`, `zona`.

### 1.3 Funciones redefinidas: versión vigente

| Función | Versiones | **Vigente** |
|---|---|---|
| `recompute_doctor(uuid)` | 0005, 0008, 0016, 0019 | **0019** |
| `recompute_all()` | 0005 | 0005 |
| `evaluate_automations()` | 0006, 0016, 0020, 0043, 0044, 0047 | **0047** |
| `doctors_guard()` | 0003, 0015, 0019 | **0019** |
| `doctors_audit()` | 0003, 0015 | 0015 |
| `doctors_journey_sync()` | 0015 | 0015 |
| `alerts_guard()` | 0004, 0022, 0030 | **0030** (lista blanca jsonb) |
| `ai_recommendations_guard()` | 0017, 0030 | **0030** |
| `cases_subject_guard()` | 0024, 0029 | **0029** |
| `activities_engagement_guard()` | 0024, 0029 | **0029** |
| `activities_edicion_guard()`, `activities_audit()`, `activities_set_sync_key()`, `events_guard()` | 0051 | 0051 |
| `handle_new_user()` | 0003, 0031 | **0031** (allowlist) |
| `opportunities_transition()` | 0003, 0011 | 0011 |
| `is_system()` | 0003, 0019 | 0019 (con search_path) |
| `team_signins()` | 0034, 0050 | **0050** |
| `tasks_transition/tasks_audit/opportunities_audit/profiles_guard/log_audit/current_rol/is_manager/can_write` | 0003/0004 | únicas |
| `tasks_default_owner`, `default_sales_owner` (0021), `tasks_cupo_automatico` (0042), `doctors_recompute_al_cruzar` (0032), `recompute_doctor_trigger` (0005), `refresh_cohort_intervals` (0005), `purge_demo` (0006), `evento_roi` (0018), `case_self_similarity` (0022), `case_subject_review_queue` (0024), `activities_default_engagement` (0022), `ai_*` (0023, 0026), `auth_allowlist_normalize/audit` (0031), `efemeride_en/doctores_efemerides` (0040), `wa_requiere_respuesta/wa_conv_unanswered/wa_marcar_respondido` (0041), `pendientes_transition` (0039), `touch_last_seen` (0050), `set_updated_at` (0002) | únicas | — |

### 1.4 Triggers vigentes por tabla

- `doctors`: BEFORE I/U `doctors_guard_trg` → `doctors_journey_trg` (orden alfabético, a propósito 0015:213) → `doctors_updated_at`; AFTER U `doctors_audit_trg`; AFTER U `doctors_cruce_recompute_trg` (WHEN cambia `is_accredited`, 0032).
- `cases`: AFTER I/U `cases_recompute_trg`; BEFORE U `cases_subject_guard_trg`; `cases_updated_at`.
- `activities`: BEFORE I `activities_engagement_trg`, `activities_sync_key_trg`; BEFORE U `activities_edicion_guard_trg`, `activities_engagement_guard_trg`, `activities_updated_at`; AFTER U `activities_audit_trg`; AFTER I/D `activities_recompute_trg`; AFTER U condicional `activities_recompute_upd_trg` (0051).
- `opportunities`: BEFORE I/U `opportunities_transition_trg`; AFTER U `opportunities_audit_trg`; AFTER I/U `opportunities_recompute_trg`.
- `tasks`: BEFORE I `tasks_default_owner_trg` → `tasks_z_cupo_automatico_trg`; BEFORE U `tasks_transition_trg`; AFTER U `tasks_audit_trg`; AFTER I/U `tasks_recompute_trg`.
- `payments`: AFTER I/U `payments_recompute_trg` (0015). `alerts`: BEFORE U `alerts_guard_trg`. `ai_recommendations`: BEFORE U guard. `profiles`: BEFORE U `profiles_guard_trg`. `auth.users`: AFTER I `on_auth_user_created`. `auth_allowlist`: normalize + audit (I/U/D). `wa_conversations`: BEFORE I/U `wa_conv_unanswered_trg`. `pendientes`: transition. `events`: BEFORE U `events_guard_trg`. `updated_at` en 20 tablas.

---

## 2. Tablas / objetos sin uso

Método: grep de `.from("x")`, `.rpc("x")`, nombres de columna en `app/`, `components/`, `lib/` (uso real) y aparte en `scripts/`.

### 2.1 Tablas — borrar después de confirmar con `select count(*)` y `pg_stat_user_tables`

| Objeto | Evidencia | Recomendación |
|---|---|---|
| `segments` (+ 4 policies) | 0 refs en app; solo `scripts/remove-itzel.ts:56` la nombra | **Drop** (P3) |
| `saved_views` (+ 4 policies, índice) | 0 refs | **Drop** (P3) |
| `custom_field_defs` (+ 3 policies) | 0 refs; `doctors.custom` solo guarda `estado_crudo` (0049) | **Drop** tabla; conservar `doctors.custom` (P3) |
| `wa_messages` (+ policy, índice) | 0 escrituras (webhook `app/api/webhooks/periskope/route.ts:191-193` solo upsertea `wa_conversations`); `lib/ai/context.ts:992` lo confirma ("está vacía") | **Drop** o dejar documentado como "futuro"; hoy es superficie sin dueño (P3) |
| `score_snapshots` | 0 lecturas; `recompute_all` (0005:405-412) inserta 7k filas/noche | **P2**: dejar de escribir (o escribir solo `is_accredited`), y truncar. Si se quiere histórico, 1 fila/doctor/semana alcanza |
| `agent_handoffs` | 1 insert (`lib/ai/orchestrator.ts:1175`), 0 lecturas | Mantener como auditoría o drop; decidir (P3) |
| `campaigns` | Solo `evento_roi()` (1 llamada en app) + 2 scripts | Mantener; es chica |
| `contacts` | Se lee en `app/(app)/doctores/[id]/page.tsx:142` y `lib/ai/context.ts:547`; no hay UI de alta; `rol_en_clinica` nunca se lee | Mantener; P3 |
| `cohort_intervals` | Solo SQL interno (`recompute_doctor`) | Mantener |

### 2.2 Columnas sin lector en la app (solo en `lib/types.ts` o solo escritas)

- `profiles.whatsapp_phone`, `profiles.avatar_url` — solo en types; `periskope_org_phone` (0041) reemplazó a la primera. **Drop** (P3).
- `cases.needs_review` — la escribe `lib/noloco-sync.ts:441`, nadie la lee. Mostrarla en /calidad o drop (P3).
- `cases.fecha_edicion`, `fecha_movimientos` — escritas por el sync; el único lector es el tipo de `lib/ai/context.ts:70-71`. Baratas (espejo); mantener.
- `cases.treatment_key` — se usa (`components/ai/milestone-track.tsx:99`). Mantener.
- `doctors.health_factors` — se calcula y nunca se muestra (P3: o se muestra en la ficha como "por qué este health" o se deja de calcular).
- `doctors.campaign_id`, `activated_by`, `reactivated_at`, `last_paid_case_at` — las escriben triggers/import; sin lector. Mantener (datos de journey), pero no hacen falta en `lib/types.ts`.
- `opportunities.campaign_id` — sin uso (P3 drop).
- `wa_conversations.asignado` — del export del 7/8, sin lector (P3).
- `goals.user_id` — la app solo escribe `null` (`lib/actions/admin.ts:85`); objetivos por persona sin UI. Mantener.
- `contacts.rol_en_clinica`, `contacts.es_principal` (solo IA) — P3.

### 2.3 Funciones / índices

- `ai_second_case_metrics()` (0026): no aparece en `lib/ai/tools/read.ts` ni en ninguna ruta → **drop** (P3). Las otras 13 `ai_*` sí se llaman (rpc dinámico en `lib/ai/tools/read.ts:93`).
- Bucket `alto_impacto`: no lo produce ningún `recompute_doctor` desde 0016; sigue en el CHECK (0015:45-48), en `lib/types.ts:50,351` y en `app/(app)/hoy/page.tsx:52`. Sacar (P3).
- Índices candidatos a estar sin uso (verificar con `pg_stat_user_indexes.idx_scan` antes): `cases_video_pendiente_idx` (0002:136; la regla ya usa `cases_render_esperando_idx`), `doctors_tags_idx` (la app no filtra por `tags` con `contains`), `doctors_expected_next_idx`.
- Triggers: ninguno muerto. `activities_engagement_guard_trg` quedó parcialmente redundante con `activities_edicion_guard_trg` (0051) pero sigue haciendo el chequeo de procedencia; dejar.

---

## 3. Estados y máquinas de estado

### 3.1 Quién escribe cada estado

| Estado | Escritores | Guard |
|---|---|---|
| `doctors.lifecycle_stage` | `recompute_doctor` (0019:285-333, 602-603), `evaluate_automations` (0047:128-133 acreditado→en_activacion; :171-178 →dormido; :194-200 →reactivado), `doctors_journey_sync` (0015:159-208, solo si el usuario no la tocó), `lib/noloco-sync.ts:409` (alta), `lib/ledger-reconcile.ts:147` (alta 'activado'), **y cualquier no-VIEWER por PATCH** | Ninguno |
| `acquisition_stage` | UI kanban (`lib/actions/journey.ts:22-25,160`), imports | Ninguno (cualquier valor, en cualquier orden) |
| `activation_stage` | UI kanban (`journey.ts:39-42`), `recompute_doctor` (0019:291,298-300), evaluador (0047:130) | Ninguno |
| `is_accredited` | `doctors_journey_sync` (regla noloco_id/accredited_at, 0015:149-151; conversión 1, :160-166), service-role (`lib/ledger-reconcile.ts:146,162`) | Sí (0019:706-712) |
| `tasks.status` | app (`lib/actions/tasks.ts:50,97`, `journey.ts:193`), evaluador, 0042 limpieza | `tasks_transition` solo pone `completed_at` |
| `alerts.status` | app (`lib/actions/alerts.ts:17`), evaluador (`reactivacion`), 0043/0047 | `alerts_guard` (0030) limita columnas, no transiciones |
| `ai_recommendations.status` | runner (`lib/ai/runner.ts:474,524`), `lib/actions/ai.ts:88,237,274` | guard 0030 (columnas), compare-and-set en app |
| `opportunities.viability_status` | /seguimiento (server action) | CHECK de dominio, sin transición |

### 3.2 Combinaciones inconsistentes que el schema permite (no hay ningún CHECK cruzado)

1. **`is_accredited = false` con `activation_stage` no nulo** — nada lo impide; llega por service-role o por PATCH directo. `ai_doctor_segments()` (0023:413-420) lo esconde (cuenta activación solo entre acreditados). *Verificar*: `select count(*) from doctors where not is_accredited and activation_stage is not null`.
2. **`is_accredited = false` con lifecycle de universo B** (`acreditado`, `en_activacion`, `activado`, `activo`, `growth`, `en_riesgo`, `dormido`, `reactivado`) — la rama A de `recompute_doctor` (0019:123-252) **nunca reescribe `lifecycle_stage`**, así que un valor importado o pateado a mano queda para siempre. Las reglas `caso_atrasado`/`sin_contacto`/`dormido_detectado` filtran solo por lifecycle (0047:45,88,175) → generan alertas/tareas sobre un no acreditado.
3. **`acquisition_stage = 'acreditado'` con `is_accredited = false`** — la conversión 1 del journey corre después del `if is_system() return` (0015:155-166): un import que ponga `acreditado` no cruza al doctor.
4. **`acquisition_stage = 'no_interesado'` con `lifecycle <> 'perdido'`** — el journey solo pone `perdido` si lifecycle no cambió en el mismo write (0015:167-171). La app ya lo parchea con `.or("lifecycle_stage.eq.perdido,acquisition_stage.eq.no_interesado")` (`app/(app)/dashboard/page.tsx:171`, `prospeccion/page.tsx:102`): síntoma de que hay dos columnas diciendo lo mismo.
5. **`is_accredited = true` sin `accredited_at`** — `ledger-reconcile.ts:162` acredita sin fecha; `ai_data_quality` lo cuenta como `accredited_without_date`. Aceptable pero conviene que ese camino ponga `accredited_at = paid_at` del primer pago.
6. **`tasks.status = 'completada'` con `completed_at` null** (INSERT directo: `tasks_transition` solo actúa en UPDATE, 0003:205) y **`'cancelada'` con `completed_at` seteado** (`lib/actions/journey.ts:~190` cancela con `completed_at`). Si el KPI "tareas completadas" filtra por `completed_at` sin `status` (`.gte("completed_at"` ×3 en app), cuenta canceladas. *Verificar.*
7. **`opportunities.stage = 'ganada'` insertada directo** → `closed_at` null (transición solo en UPDATE, 0011:5) → `ai_pipeline_summary` la excluye de "cerradas" (0023:215-223).
8. **Viabilidad con dos representaciones**: `stage = 'viabilidad'` (0010) y `viability_status` (0022). 0043:321 tiene que consultar las dos. Puede haber `stage='viabilidad'` con `viability_status='respondida'` y `viability_completed_at` cargado.
9. **`ai_recommendations.status = 'aceptada'` terminal con `outcome = 'Error al ejecutar…'`** (`lib/actions/ai.ts:113-119`): estado "quemado" por diseño; no hay `reintentar`. Aceptable si se acepta que el runner vuelva a proponer (el índice de dedupe solo bloquea `propuesta`).
10. `lifecycle_stage` con valores deprecados: 0015:59-62 migró filas, pero el enum los sigue aceptando y el TS también (`lib/types.ts:17`).

### 3.3 ¿Demasiados estados? Sí. Diagnóstico

- Para el universo A, `lifecycle_stage` es una **proyección** de `acquisition_stage` (mapa fijo en 0015:175-184). Dos columnas, una verdad.
- Para el universo B, `lifecycle_stage` es una **derivación** de `cases`/`payments` (recompute) más dos reglas del evaluador con umbrales propios (`dormido` a 2.0×, `reactivacion` a 7 días vs recompute `reactivado` a 60 días). Dos escritores, una columna.
- `growth` no se asigna nunca; `acreditado` es transitorio (recompute lo pisa en la misma transacción: 0019:287-292); `alto_impacto` es un bucket muerto.

### 3.4 Simplificación concreta (sin sobreingeniería)

1. **Una sola pluma para `lifecycle_stage`**: mover las transiciones `→dormido`, `→reactivado` y `acreditado→en_activacion` de `evaluate_automations` a `recompute_doctor` (que ya maneja `en_riesgo`, `reactivado`, `perdido`). El evaluador queda solo para emitir alertas/tareas leyendo el lifecycle. Umbrales: los de recompute (`en_riesgo` 1.25-2.0, `dormido` ≥2.0, `reactivado` ≤60 d).
2. **`lifecycle_stage` pasa a ser columna del sistema**: agregarla (junto con `activation_stage` derivada y `last_contact_at`) a la lista protegida de `doctors_guard` (0019:682-704). Los humanos mueven `acquisition_stage`/`activation_stage` por el kanban, como hoy.
3. **Universo A sin lifecycle propio**: dejar `lifecycle_stage in ('prospecto','perdido')` para no acreditados y que la UI muestre `acquisition_stage`. `CHECK (is_accredited or lifecycle_stage in ('prospecto','perdido'))` y `CHECK (is_accredited or activation_stage is null)` — aplicar después de corregir datos con un UPDATE de una línea.
4. **Deprecados**: Postgres no borra valores de enum; agregar `CHECK (lifecycle_stage not in ('acreditacion_pendiente','acreditado_no_activado'))` y sacarlos de `lib/types.ts`. Sacar `alto_impacto` del CHECK de bucket, de `BUCKET_LABELS` y de `/hoy`.
5. **Viabilidad**: elegir `viability_status` como única verdad y dejar `stage='viabilidad'` como etapa de kanban que se setea junto con `viability_status='solicitada'` (o al revés), pero que una sola columna dispare la regla.
6. Mini-CHECKs baratos: `tasks: (status='completada') = (completed_at is not null)` (previo UPDATE de saneo); `alerts: status='abierta' or resolved_at is not null`; `goals.metric in ('paid_cases','accreditations')`; `sync_runs.status in ('running','ok','error')`.

---

## 4. pg_cron y automation_rules

### 4.1 Jobs de pg_cron (únicos en las 51 migraciones)

| Job | Horario | Corre | Migración |
|---|---|---|---|
| `crm-recompute-nightly` | `0 11 * * *` (05:00 MX) | `select recompute_all()` | 0006:317 |
| `crm-automations-hourly` | `10 * * * *` | `select evaluate_automations()` | 0006:318 |

Ninguna migración posterior re-agenda, cambia ni borra jobs. Observaciones:
- 0006:314-321 envuelve `create extension pg_cron` + los dos `cron.schedule` en un `DO … exception when others then raise notice`: si la extensión no estaba habilitada en el proyecto, **la migración pasa en verde sin agendar nada**. `docs/OPERACION.md:197` dice que el nocturno está "verificado activo"; el horario lo confirma indirectamente 0042:9-11 (281 tareas/día). Recomendación: chequeo 9 en `security-checks.ts`: `select jobname from cron.job` debe tener los dos.
- Los jobs viven fuera del ledger/checksum. Una restauración desde cero necesita re-crearlos; agregar al runbook.
- `cron.job_run_details` crece sin poda; agregar job `delete from cron.job_run_details where end_time < now() - interval '14 days'`.
- Además hay 8 crons de Vercel (`vercel.json`): noloco cada 2 h (llama `recompute_all` vía PostgREST y suele cortar por timeout, `lib/noloco-sync.ts:485-488`), actividades 15:00, alerta */10, brief 13:00, asistencia 23:30 L-V, render 30 */2, calendar 12:45 L-V, pagos 23:10 L-V. Todos con service-role → `is_system()` true → **ningún guard corre** en esas escrituras (documentado y aceptado; anotarlo en el runbook).

### 4.2 Reglas (`automation_rules`, estado final tras 0006, 0011, 0016, 0020, 0042, 0043)

| key | Qué hace | Umbral (`params`) | Crea tarea |
|---|---|---|---|
| `caso_atrasado` | alerta `alta` + tarea llamada; lifecycle activo/growth/reactivado con confianza personal/cohort | `threshold` 1.25 × ritmo propio | sí (llamada) |
| `sin_contacto` | tarea WhatsApp; lifecycle activo/growth/activado/reactivado | `days` 30 desde `last_contact_at` | sí |
| `oportunidad_estancada` | alerta `media` por oportunidad | `multiplier` 1.5 × `expected_days` {viabilidad 10, pp 14, doc 7, ci 7, plan 7, pres 5, dec 4, comp 7} | no |
| `acreditado_no_activado` | mueve `acreditado`→`en_activacion`; alerta `alta` + tarea llamada | `days` 30 desde `accredited_at` | sí |
| `dormido_detectado` | mueve a `dormido`; alerta `critica` | `threshold` 2.0 × ritmo | no |
| `reactivacion` | dormido/en_riesgo/perdido con caso nuevo <7 d → `reactivado`; cierra alertas dormido/caso_atrasado; alerta `info` | 7 días (hardcode) | no |
| `tarea_vencida` | alerta `media`, una por doctor | `days` 3 de vencimiento | no |
| `aprobacion_pendiente` (0047) | alerta por doctora agregando renders en `video_stage='ATENCION'` + `video_sub_stage='PENDIENTE_APROBACION_RENDER'` | `days` 7; `alta` si el más viejo > `days_critico` 14 | no |
| `viabilidad_sin_respuesta` (0043) | alerta por oportunidad con `viability_status in (solicitada, enviada)` o `stage='viabilidad'` | `days` 7 / `days_critico` 14 | no |
| `prospecto_sin_seguimiento` (0016/0020/0042) | tarea WhatsApp a prospectos calificados sin contacto | `days` 14; `min_interest` 3 o `min_casos_mes` 2 o etapa reunión/interés; orden `priority_score`; `max_per_run` 5 | sí |

### 4.3 Cupo diario (0042)

Trigger `tasks_z_cupo_automatico_trg` BEFORE INSERT (0042:57-118), solo para `automation_rule_id is not null` **y `assigned_to is not null`**:
1. No resucitar: si (doctor, regla) tuvo `cancelada`/`completada` con `updated_at` en 30 días → descarta.
2. Máx 5 creadas por asignado por día (día de México, sobre `created_at`).
3. Máx 5 automáticas `pendiente` abiertas por asignado.
Descarta devolviendo NULL (silencioso). `run_stats.last_created` es fiel en las ramas con `get diagnostics`, pero en `caso_atrasado` y `acreditado_no_activado` cuenta alertas, no tareas (0047:62,153).

**Huecos** (P2):
- `assigned_to null` saltea el cupo (0042:71-73). Hoy `tasks_default_owner` asigna al único SALES; con 2 SALES activos `default_sales_owner()` devuelve null (0021:15-17) y las cuatro reglas vuelven a crear sin tope. Fix: si `assigned_to` es null, contar el cupo contra `doctors.owner_id` o rechazar la fila.
- Las tareas del flujo IA (`lib/actions/ai.ts:127-135`) nacen con `automation_rule_id` null → sin cupo (aceptable; son humanas).
- Freno 3 usa `updated_at` de tareas: la limpieza masiva del 26/8 puso `updated_at` en todas → 30 días de silencio para esos pares doctor/regla (intencional, pero conviene saberlo).

---

## 5. Seguimiento / next action

### 5.1 Cómo se calcula (versión vigente = 0019)

- **Universo A** (0019:123-252): `reasons` por `acquisition_stage` (`interes_acreditacion` 0.9, `reunion_hecha` 0.85, `acreditacion_agendada` 0.7, `reunion_agendada` 0.6, `prospecto_enfriandose` 0.65, `sin_contacto_logrado` 0.5, `prospecto_nuevo` 0.45) + `tarea_vencida` 0.7 + `interes_alto` 0.55; `priority = 100·decay·(0.45·urgencia + 0.35·potential + 0.20·engagement)`; `bucket = 'nuevo_negocio'` (null si perdido/no_interesado); `recommended_action` = mapa fijo código→{type,label} (0019:213-223).
- **Universo B** (0019:428-599): códigos `perdido_antiguo` 0.1, `caso_muy_atrasado` 1.0, `caso_atrasado` 0.6, `acreditado_no_activado` 0.9, `activacion_fresca` 0.8, `primer_caso_sin_repetir` 0.75, `reactivado_reciente` 0.65, `oportunidad_estancada` 0.8, `seguimiento_oportunidad` 0.75, `tarea_vencida` 0.7, `sin_contacto` 0.5, `volumen` 0.3, `growth` 0.4. `priority = 100·decay·(0.30·urgencia + 0.20·potential + 0.20·volumen + 0.15·valor + 0.15·prob)` con ×0.15 perdido y ×0.45 si 1-3 casos. `bucket` y `recommended_action` por el código de mayor peso (0019:571-599). `decay` 0.5 si hubo actividad en 3 días.
- **0043/0044 no tocan nada de esto**: agregan reglas de alerta. Consecuencia: una doctora con 4 renders parados o una viabilidad sin respuesta **no tiene código en `priority_reasons` ni `recommended_action`**; solo aparece en /seguimiento y en alertas, no en el motor de /hoy (que agrupa por `priority_bucket`, `app/(app)/hoy/page.tsx:109-124`). P2: agregar en recompute dos reasons (`render_sin_aprobar` 0.8, `viabilidad_sin_respuesta` 0.7) leyendo `cases.video_stage/sub_stage` y `opportunities.viability_*` — recompute ya lee `alerts` para la severidad crítica (0019:369-372), así que el patrón existe.

### 5.2 ¿Existe `next_action` / `next_action_at` por doctor?

No. Lo más cercano: `doctors.recommended_action` (qué, sin fecha), `doctors.expected_next_case_at` (predicción, no compromiso), `tasks.due_date` (por tarea), `opportunities.viability_follow_up_date`, `activities.next_action` (texto libre, 0022:73, nadie lo lee como fecha). Recomendación mínima: una **vista** `doctor_next_touch` = `min(tarea pendiente due_date, viability_follow_up_date, recommended_date de recomendación IA propuesta)` por doctor; sin columna nueva ni trigger. Si /hoy la necesita ordenada, materializar en recompute como `doctors.next_action_at`.

### 5.3 Dedupe y anti-flood

- Tareas automáticas: `NOT EXISTS (pendiente para doctor+regla)` en cada rama (0047:76-78, 91-93, 166-168, 326-328) + veda de 30 días + cupos (0042). No hay índice único que lo garantice; el evaluador corre en serie, alcanza.
- Alertas: índices únicos parciales `(rule_key, doctor_id)` y `(rule_key, opportunity_id)` sobre `status='abierta'` (0002:218-221) + `NOT EXISTS`. Bien.
- Historia del flood: 0020 (acota prospectos + tope 25 + borra 4.945), 0021 (dueño por defecto), 0042 (cupo 5/5/30 d + cancela backlog + tope 5). Hueco restante: §4.3.

---

## 6. Integridad

### 6.1 FKs

Presentes en casi todo. Faltan/decisiones a documentar:
- `audit_log.actor_id` sin FK a `profiles` (0002:271) — aceptable (histórico sobrevive a bajas), documentar.
- `alerts.rule_key` texto sin FK a `automation_rules.key` — `automation_rules` no tiene policy de delete, así que no hay huérfanos hoy. P3.
- `ai_recommendations.run_id`, `agent_handoffs.run_id` sin FK — deliberado (0017:23). OK.
- Cascadas: borrar un doctor arrastra `contacts`, `opportunities`, `alerts`, `tasks`, `activities`, `score_snapshots`, `ai_recommendations`, `doctor_ai_profile`, `agent_handoffs`; `set null` en `agent_runs`, `wa_conversations`, `event_attendees`, `calendar_events`; `payments.doctor_id` y `cases.doctor_id` **restrict** (sin `on delete`) → un doctor con casos/pagos no se puede borrar (bien).

### 6.2 Índices faltantes para lo que la app consulta (grep de `.eq/.in/.order` por tabla)

| Tabla | Consulta real | Índice hoy | Falta |
|---|---|---|---|
| `cases` | `render-v2-sync`/alerta matchean por `id_externo`; `search.ts:29` `id_externo ilike` | ninguno | `create unique index cases_id_externo_uq on cases (id_externo) where id_externo is not null` (verificar duplicados antes) |
| `alerts` | `recompute_doctor` hace `exists(... where doctor_id=p and status='abierta' and severity='critica')` × 7k doctores por noche (0019:369-372); ficha filtra por `doctor_id` | solo el único parcial `(rule_key, doctor_id)` | `alerts (doctor_id) where status='abierta'` |
| `audit_log` | `/equipo/actividad`: `source='app' and actor_id not null and created_at between` (`lib/actividad-equipo.ts:135-138`) | `(entity_type, entity_id, created_at)`, `(field, created_at)` | `(actor_id, created_at) where actor_id is not null` |
| `activities` | cron lee **todas** las filas para el Set de dedupe (`lib/actividades-sync.ts:95-99`) | — | índice sobre `sync_key` y pasar el dedupe a `where sync_key = any($1)` cuando pase de ~20k filas |
| `doctors` | `/hoy` `.in("priority_bucket", …)` + `order priority_score` (`hoy/page.tsx:113`); webhook `phone ilike '%last10%'` (`app/api/webhooks/periskope/route.ts:163`) | `priority_idx`, `nombre` trgm | `doctors (priority_bucket, priority_score desc) where priority_bucket is not null`; columna `phone_e164` generada + índice (y de paso unique parcial cuando se limpien duplicados) |
| `tasks` | KPI `gte(completed_at)` ×3 | `(assigned_to, status, due_date)`, `(doctor_id)` | `(completed_at) where status='completada'` (P3) |
| FK sin índice (cascadas y joins) | `tasks.opportunity_id`, `tasks.alert_id`, `tasks.created_by`, `activities.opportunity_id`, `opportunities.case_id`, `payments.case_id`, `alerts.resolved_by`, `doctors.clinical_owner_id`, `doctors.activated_by`, `ai_recommendations.decided_by`, `wa_conversations.doctor_id` (solo parcial) | — | a este volumen (<100k filas) P3; el que importa es `wa_conversations (doctor_id)` completo (merge/borrado de doctores) |

### 6.3 Unique constraints faltantes

- `doctors`: nada sobre teléfono/email → los duplicados existen (`scripts/merge-prospect-dups.ts`, `lib/ledger-reconcile.ts:20-31` "García Garduño ×2"). Mínimo: `phone_e164` generada (`lib/phone.ts` ya normaliza) + reporte de duplicados; unique parcial solo cuando la lista esté limpia. P2.
- `cases.id_externo` (§6.2). `event_attendees (event_id, doctor_id) where doctor_id is not null` (P3). `activities.sync_key`: **no** unique (dos notas manuales iguales el mismo día son legítimas); índice normal.
- `noloco_id` ✓, `instagram` ✓, `external_key` ✓ (payments, opportunities), `campaigns.nombre` ✓, `commercial_offers (market,name)` ✓, `calendar_events (profile_id, google_event_id)` ✓, `auth_allowlist.email` ✓, `goals` ✓.

### 6.4 Soft delete

No existe en ninguna tabla. Borrado físico hoy: `events`/`pendientes` desde la app (`lib/actions/events.ts:107`, `pendientes.ts:129`) — correcto; `doctors` desde 4 scripts service-role (`merge-prospect-dups.ts:111`, `limpiar-basura.ts:87`, `borrar-ficha-interna.ts:58`, `verificar-journey*.ts`) — **hace falta**: (a) la cascada se lleva actividades, tareas, alertas y recomendaciones IA y `audit_log` queda con ids huérfanos; (b) un acreditado borrado con `noloco_id` **vuelve a nacer** en el próximo `/api/sync/noloco` (upsert por `noloco_id`, `lib/noloco-sync.ts:406-418`) sin historia. Mínimo viable: `doctors.merged_into_id uuid references doctors` + `doctors.deleted_at timestamptz`; el merge re-apunta hijos y marca; RLS de lectura `deleted_at is null`; el sync respeta `merged_into_id`. Para tareas/alertas/pendientes no hace falta: ya tienen `cancelada`/`descartada`.

### 6.5 Timestamps

`created_at` en todas; `updated_at` con trigger en 20 tablas. Faltantes que importan: **`events`** (0051 abrió edición de `notas` y no hay ni `updated_at` ni audit → una corrección no deja rastro; P3), `ai_recommendations` (tiene `decided_at/resolved_at`, alcanza). Tipos correctos (`timestamptz`/`date`). `goals.period` sin CHECK de primer día de mes.

### 6.6 Auditoría

| Tabla | Trigger de audit | Qué registra | Qué NO |
|---|---|---|---|
| `doctors` | `doctors_audit` (0015) | lifecycle, acquisition, activation, accredited_at, owner, categoria, potential_override | teléfono/email/zona/state/observaciones/tags/**is_demo** |
| `opportunities` | 0003 | stage, owner, forecast_category | amount, probability, viability_* |
| `tasks` | 0003 | status | assigned_to, due_date, outcome |
| `activities` | 0051 | summary, outcome | — (edición ya limitada por guard) |
| `auth_allowlist` | 0031 | todo, incl. DELETE | — |
| `alerts`, `ai_recommendations` | ninguno | `resolved_by/at`, `decided_by/at` hacen de rastro | — |
| **`profiles`** | ninguno | — | **cambios de `rol`** (P2: escalada sin huella) |
| `automation_rules`, `commercial_offers`, `goals`, `events`, `contacts`, `payments`, `cases` (fuera de `case_subject_*`) | ninguno | — | P3 |

Fuente (`audit_log.source`): `'app'` por defecto, `'automation'` (evaluador), `'migracion_0042'`. Nunca `'import'`, nunca `'agent'` (la capa IA no escribe tablas CRM por diseño, `lib/ai/db.ts:3-7`; y las acciones aceptadas corren con la sesión del usuario → `'app'`). Los crons service-role no setean `app.source` (grep: ningún `set_config` en `lib/`/`app/`) → sus cambios quedan `source='app', actor=null`, indistinguibles de recompute nocturno. **P2 concreto**: (1) `recompute_doctor` debe hacer `set_config('app.source','recompute',true)` en su primera línea (0019:65) — hoy un usuario que carga una actividad dispara recompute → cambio de lifecycle auditado a su nombre y contado en `/equipo/actividad`; (2) `evaluate_automations` ya lo hace; (3) los crons podrían llamar `rpc('set_source','sync-x')` al abrir… con PostgREST no persiste entre requests, así que la opción realista es que `log_audit` use `coalesce(app.source, case when auth.uid() is null then 'system' else 'app' end)`.

---

## 7. RLS y permisos

### 7.1 Matriz efectiva (rol `authenticated`; `service_role` bypasea todo)

| Tablas | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `doctors`, `contacts`, `opportunities`, `activities`, `tasks`, `segments` | todos (`using true`) | `can_write()` | `can_write()` (+ guards en doctors/activities) | `is_manager()` |
| `alerts` | todos | — (sistema) | `can_write()` + guard 0030 | — |
| `cases` | todos | — | `can_write()` + guard (solo `case_subject_*`) | — |
| `payments`, `audit_log`, `score_snapshots`, `sync_runs`, `wa_conversations`, `wa_messages`, `cohort_intervals`, `doctor_ai_profile`, `agent_runs`, `agent_handoffs` | todos | — | — (wa: solo vía `wa_marcar_respondido`) | — |
| `ai_recommendations` | todos | — | `can_write()` + guard 0030 | — |
| `profiles` | todos | — (trigger auth) | propia o manager + guard de `rol` | — |
| `saved_views`, `pendientes` | todos | propio | propio | propio o manager |
| `goals`, `campaigns`, `custom_field_defs`, `commercial_offers` | todos | manager | manager | manager |
| `automation_rules` | todos | — | manager | — |
| `events` | todos | `can_write()` | autor + `can_write()` + guard (solo `notas`, 0051) | **`can_write()`** |
| `event_attendees` | todos | `can_write()` | — | **`can_write()`** |
| `calendar_events` | todos | `can_write()` | `can_write()` | `can_write()` |
| `auth_allowlist` | **manager** | manager | manager | manager |
| `alerta_rechazos_estado`, `ops.*` | nadie (RLS sin policy / schema cerrado) | — | — | — |

### 7.2 Funciones SECURITY DEFINER con EXECUTE para `authenticated`

`ai_*` (13 en uso + `ai_second_case_metrics`), `evento_roi`, `doctores_efemerides`, `efemeride_en`, `case_self_similarity`, `default_sales_owner`, `current_rol`, `is_manager`, `can_write`, `wa_requiere_respuesta`, `wa_marcar_respondido` (gate `can_write`), `team_signins` (gate roles de gestión), `touch_last_seen` (solo su fila), `recompute_all`/`evaluate_automations`/`purge_demo` (gate `is_manager` interno), `case_subject_review_queue` (INVOKER). Solo `service_role`: `recompute_doctor`, `refresh_cohort_intervals`. Sin grant a nadie: `log_audit` y las 20+ funciones de trigger. `anon`: 0 (0027 + revokes explícitos posteriores; el `alter default privileges` de 0027:99 **no alcanzó** para 0031 según HOTFIX_LOG:197-201 → seguir con revokes explícitos, como hacen 0032-0051).

Ninguna función devuelve más de lo que la policy `using (true)` ya deja leer. No hay SQL dinámico con input de usuario. Todas las DEFINER tienen `set search_path` (0019 arregló `is_system`). No hay agujero por función.

### 7.3 Agujeros reales (por prioridad)

1. **P1 — `is_demo` escribible** en `doctors`, `opportunities`, `tasks`, `contacts` por cualquier no-VIEWER (PATCH a PostgREST; `doctors_guard` 0019 no lo lista; `tasks`/`opportunities`/`contacts` no tienen guard). Un ADMIN que apriete "purgar demo" (`purge_demo`, 0006:288-294) borra físicamente al doctor marcado y su historia. Fix de 6 líneas: agregar `is_demo` a la lista protegida de `doctors_guard` y crear guards de lista blanca (patrón 0030) para `tasks` (`status, outcome, completed_at, due_date, assigned_to, title, type, updated_at`) y `opportunities` (todo menos `is_demo, doctor_id, created_at, external_key`).
2. **P1 — columnas de estado del doctor sin guard**: `lifecycle_stage`, `acquisition_stage` (cualquier salto), `activation_stage`, `last_contact_at` (`lib/actions/tasks.ts:64-67` la escribe a mano aunque recompute la recalcula), `tags`, `source`. Ver §3.4.
3. **P1 — `tasks_update` sin guard**: reasignar, mover `due_date`, cambiar `automation_rule_id` a null (saltea cupo y veda), `created_by`, `doctor_id`, `completed_at` (KPI). Mismo fix que 1.
4. **P2 — DELETE abierto** en `events`, `event_attendees`, `calendar_events` para cualquier no-VIEWER. `calendar_events` es espejo: sacar todas las policies de escritura (el sync es service-role). `events_delete`/`event_attendees_delete`: `created_by = auth.uid() or is_manager()`.
5. **P2 — lectura total** (`using (true)` en 30 tablas: teléfonos, nombres de paciente, pagos, audit, corridas IA) para cualquier cuenta, incluido `VIEWER`. Decisión de producto (8/8) y mitigada por `disable_signup` + allowlist; pero `VIEWER` existe y no tiene uso. Opción barata: `drop` del rol o policy `using (current_rol() <> 'VIEWER')` en `payments`, `audit_log`, `agent_runs`, `ai_recommendations`, `wa_conversations`.
6. **P3 — `profiles_update_own`** deja al usuario editar su propio `activo` (afecta `default_sales_owner`), `last_seen_at` (presencia falsa) y `nombre`. Guard de lista blanca `nombre, avatar_url, periskope_org_phone`.
7. **P3 — `is_system() = auth.uid() is null`**: cualquier conexión sin JWT (SQL editor de Supabase, scripts, crons) saltea todos los guards. Es el diseño; anotarlo en OPERACION.md como "el service-role escribe verdad sin red".

---

## 8. Migraciones y runner

### 8.1 Inconsistencias entre migraciones

- 0006:309-311 `revoke … from anon` sin tocar PUBLIC no hacía nada (corregido en 0027). Histórico.
- 0015:40-41 y 0040:41 crean el mismo `doctors_accredited_at_idx` (`if not exists`; inofensivo).
- 0017, 0022, 0023, 0024, 0026 dicen "no hay ledger, idempotente" — desde 0028 hay ledger; los comentarios mienten pero el SQL es correcto.
- 0043 introdujo `case … end` de tipo `text` en columna enum (rompe `evaluate_automations` entera) → 0044 lo arregla. Habría saltado con un `--ensayo` seguido de `select evaluate_automations()`; hoy el runner no ejecuta smoke tests. Ver 8.3.
- 0043:378 y 0047:22 resuelven alertas; 0044:328-333 y 0047:344-355 **ejecutan `evaluate_automations()` dentro de la migración** (crean alertas y tareas reales); 0042:45-50 cancela tareas; 0020:18-23 borra tareas; 0019:642-650 borra campañas duplicadas. Bajo `--ensayo` se revierte; bajo `--apply` son efectos de negocio con checksum de schema. Regla propuesta: las correcciones de datos van a `scripts/` con `confirmarDestino({destructivo:true})`, o a un directorio `supabase/data/` que el runner no considere parte del schema.
- Objetos creados y abandonados: `segments`, `saved_views`, `custom_field_defs`, `wa_messages` (0002); `score_snapshots` (0002/0005, escrita y no leída); `ai_second_case_metrics` (0026); bucket `alto_impacto`; enum `acreditacion_pendiente`/`acreditado_no_activado`; `campaigns` casi.
- Docs vs. realidad: `docs/OPERACION.md:8-9` "mismo host, ca-central-1" — falso (`environments.json:4`: prod `us-east-2`); `scripts/lib/pg.ts:13` idem; `OPERACION.md:176` "no hay despliegue" — hay Vercel; `OPERACION.md:148-152` cuenta 3 pendientes de security-checks que ya se cerraron.

### 8.2 Rollbacks

- **Faltan** (migraciones con rollback = 19 de 51): 0030 (guards → habría que reponer las versiones de 0017/0022), 0036 (columna + unique + CHECK), 0037 (tabla), 0038 (enum: irreversible, decirlo), 0044 y 0047 ("reaplicar 0044/0020": funciona solo nombrando el archivo, y el runner pisa el checksum del ledger sin avisar). 0001-0026 no tienen rollback (histórico; 0015/0019/0020 son irreversibles).
- **Rotos**: `rollbacks/0043_…:7` usa `\echo` (meta-comando psql) → error de sintaxis con node-pg; `rollbacks/0033_…:4` devuelve EXECUTE a PUBLIC (viola `OPERACION.md:122`): borrarlo.
- **Runner + rollback (P1)**: correr `rollbacks/0051_…` deja `ops.schema_migrations` con `0051_editar_notas.sql` "aplicada" → `--apply` la saltea para siempre y `--check-connection` miente. Fix mínimo en `aplicarArchivo`: si `esRollback(ruta)`, en la misma transacción `delete from ops.schema_migrations where filename = <0051_editar_notas.sql>` (derivar el nombre quitando `_rollback`).

### 8.3 El runner (`scripts/db-migrate.ts`) — ¿seguro desde CI?

Lo que está bien: modo por defecto `--dry-run`; `--apply` explícito; prod exige TTY y tipear el ref (`--yes` no alcanza, `db-migrate.ts:173-194`); checksum + divergencia; transacción por archivo con la fila del ledger; `--ensayo` para cadenas; chequeo "base migrada con ledger vacío" antes de escribir; decisiones puras testeadas (`db-migrate.test.ts`, 20 casos).

**Cambio en curso detectado durante la auditoría**: `scripts/lib/destino.ts` incorporó `refConfirmado` / `refConfirmadoValido()` (`--confirmar <ref>` como reemplazo de la confirmación por TTY, pensado para GitHub Actions). Si `db-migrate.ts` toma el mismo camino, CI va a poder escribir en producción: en ese escenario los puntos 1-3 de abajo (lock, timeouts, TLS) dejan de ser deuda y pasan a ser prerrequisito, y el workflow tiene que vivir en un `environment` protegido con aprobación manual, separado de `crm-mx-ci.yml`.

Lo que le falta para CI (hoy CI no toca DB por diseño, `crm-mx-ci.yml:9-11`):
1. **Lock**: nada impide dos corridas concurrentes. `select pg_advisory_lock(hashtext('crm-migrate'))` al conectar.
2. **`lock_timeout`/`statement_timeout`**: un `alter table doctors` contra una base en uso puede quedar esperando detrás de una transacción larga y bloquear a la app. `set lock_timeout='5s'` por sesión.
3. **TLS**: `ssl: { rejectUnauthorized: false }` (`db-migrate.ts:138`, `pg.ts:48`). Pasar el CA de Supabase.
4. **Validación sin base real**: un job con `services: postgres:15` que aplique 0001..N desde cero (`--apply --yes` con un ref registrado como `desarrollo`) y luego llame `select evaluate_automations(); select recompute_all();` — habría atrapado 0043. Requiere `create role anon/authenticated/service_role` + `schema auth` mínimo (un archivo `ci/bootstrap.sql` de 30 líneas). No necesita secretos.
5. **`applied_by`**: siempre `postgres` (`0028:30`, `db-migrate.ts:217`); pasar `MIGRATE_ACTOR`/`$USER` para saber quién corrió.
6. **Re-aplicar por nombre explícito** pisa el checksum del ledger sin flag (`db-migrate.ts:544-547, 216-222`). Exigir `--permitir-divergencia` también ahí.
7. **Duplicación** `connect()` en `db-migrate.ts` vs `pg.ts` (BAJ-14) y lista de regiones distinta.
8. `diff-entornos.ts` compara firmas, no cuerpos (documentado): agregar `md5(pg_get_functiondef(oid))` — una línea.

---

## 9. Backups

**Hoy**: `scripts/backup-datos.ts` — manual, NDJSON por tabla de `public`, ordenado por PK, manifiesto con conteos y ledger; escribe a `~/crm-mx-backups/<ref>-<fecha>/`. Se corrió antes de 0031/0032 (94.219 filas, HOTFIX_LOG:193). Plan Free en Supabase: sin backups administrados ni PITR (`OPERACION.md:169-172`). **Nunca se probó una restauración.**

**Qué falta (P0 en conjunto)**:
1. No es automático: depende de que alguien lo corra antes de migrar. Un `drop`/`delete` accidental un martes a las 16:00 no tiene punto de retorno.
2. No incluye `auth.users`/`auth.identities` → sin usuarios, `profiles` no se puede recargar (FK) y todos los `owner_id`, `created_by`, `assigned_to`, `decided_by` quedan colgados. Tampoco `ops.*` ni `cron.job`.
3. No existe cargador: NDJSON con enums, arrays y jsonb no se reimporta con `\copy` sin transformar; el manifiesto dice "recargar respetando dependencias" y nadie lo escribió.
4. PII (7.034 doctores, nombres de paciente) sin cifrar en el disco de una laptop.
5. `pg.ts:13` prueba `ca-central-1` primero: contra prod son intentos fallidos antes de acertar; no es un bug, es fricción para algo que debería ser un comando.

**Mínimo razonable**:
- **Opción A (recomendada, 0 código)**: Supabase Pro en el proyecto de producción → backups diarios 7 días, PITR opcional. Es la única forma de tener recuperación a punto en el tiempo.
- **Opción B (si sigue Free)**: workflow de GitHub Actions nocturno, separado de `crm-mx-ci.yml` y con `environment: prod-backup` protegido, que corra `pg_dump -Fc --schema=public --schema=ops --schema=auth` vía pooler y suba el artefacto cifrado (age/gpg) a un bucket; retención 14 días. Rompe la regla "CI sin secretos" a propósito y para un solo job.
- En los dos casos: **un simulacro de restore** en el proyecto de desarrollo (ya tiene los mismos datos) con checklist: crear proyecto → `pg_restore` → `cron.schedule` × 2 → `--check-connection` → smoke `/hoy`. Anotar duración. Repetir por trimestre.
- Mantener `backup-datos.ts` como "foto previa a migración" pero agregarle `auth.users` (solo `id, email, raw_app_meta_data, created_at`) y `ops.*`.

---

## 10. Plan mínimo sugerido (orden)

1. **Backups** (§9): Pro en prod o workflow nocturno + simulacro de restore. Una tarde.
2. **Migración 0052 "guards"**: `is_demo` + `lifecycle_stage` + `activation_stage` + `last_contact_at` + `tags`/`source` a `doctors_guard`; guard de lista blanca en `tasks` y `opportunities`; `events_delete`/`event_attendees_delete` al autor o manager; quitar policies de escritura de `calendar_events`; guard de `profiles` (nombre/avatar/periskope). Con autoverificación como 0030. Una tarde.
3. **Runner**: borrar fila del ledger al correr un rollback; advisory lock; `lock_timeout`; arreglar `rollbacks/0043` y borrar `rollbacks/0033`. Una hora.
4. **Migración 0053 "una pluma"**: mover `dormido`/`reactivacion`/`acreditado→en_activacion` a `recompute_doctor`; `set_config('app.source','recompute')`; sumar reasons de render/viabilidad; dejar de escribir `score_snapshots`; CHECKs de §3.4 tras saneo. Un día, con `--ensayo` + `select recompute_all()`.
5. **Índices** (§6.2): `cases(id_externo)` unique, `alerts(doctor_id) where abierta`, `audit_log(actor_id, created_at)`, `activities(sync_key)`, `doctors(priority_bucket, priority_score)`. Media hora.
6. **Limpieza** (§2): drop `segments`, `saved_views`, `custom_field_defs`, `wa_messages`, `ai_second_case_metrics`, `profiles.whatsapp_phone/avatar_url`; sacar `alto_impacto` y los dos lifecycle deprecados del TS + CHECK. Media hora, con rollback.
7. **Soft delete de doctores** (`merged_into_id`, `deleted_at`) y que `merge-prospect-dups` lo use. Medio día.
8. **CI con Postgres de servicio** aplicando 0001..N desde cero + smoke de las dos funciones grandes. Medio día.

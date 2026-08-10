-- 0023: agregados de la capa AI calculados EN POSTGRES.
--
-- El bug que cierra: PostgREST corta TODO select en 1.000 filas y no avisa.
-- Con 6.4k doctores / 1.017 casos / 4.257 actividades, cada tool que traía filas
-- y las contaba en JS podía devolverle al Director Comercial un número
-- silenciosamente incompleto — el peor error posible, porque su trabajo es
-- citarle números al manager.
--
-- Regla de esta migración: el COUNT/SUM/GROUP BY se hace del lado del servidor y
-- la función devuelve SOLO el agregado. Nada de traer 6.000 filas al modelo para
-- contarlas.
--
-- Contrato de salida (lo consume lib/ai/completeness.ts):
--   * jsonb siempre.
--   * 'rows_considered': cuántas filas MIRÓ el servidor para calcular (no cuántas
--     devuelve). Es la base de la honestidad del caller.
--   * toda lista top-N viaja con su total real al lado ('<algo>_total') para que
--     el caller pueda decir "estos 50 de 6.204".
--   * 'advertencias': array de strings con lo que hace que el número NO esté
--     completo (listas capadas, filas sin atribuir, campos vacíos). Viajan tal
--     cual a DataCompleteness.limitations y ponen complete=false.
--   * 'notas': cómo LEER el número (qué cuenta y qué no). No afectan complete —
--     viajan dentro del data para que el agente no confunda dos métricas.
--   * NUNCA se infiere: lo desconocido se reporta como desconocido (null o un
--     contador aparte), jamás se completa con una suposición.
--
-- Fechas de negocio en America/Mexico_City: el server corre en UTC y el corte de
-- mes se movería 6 horas.
--
-- security definer + search_path=public: las policies de 0004 ya son "todos los
-- autenticados leen todo", así que esto no expone nada nuevo; solo evita que el
-- planner tenga que reevaluar RLS fila por fila en agregados de 6.4k filas.
--
-- Idempotente (no hay ledger de migraciones): create or replace en todo.

-- ---------------------------------------------------------------------------
-- 0. Helpers de fecha MX
-- ---------------------------------------------------------------------------

create or replace function ai_mx_date(p timestamptz)
returns date language sql immutable set search_path = public as $$
  select (p at time zone 'America/Mexico_City')::date
$$;

create or replace function ai_mx_today()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'America/Mexico_City')::date
$$;

create or replace function ai_mx_month_start()
returns date language sql stable set search_path = public as $$
  select date_trunc('month', (now() at time zone 'America/Mexico_City'))::date
$$;

comment on function ai_mx_date(timestamptz) is
  'Fecha de negocio (America/Mexico_City) de un timestamptz. El server corre en '
  'UTC: comparar directo corre el corte de día/mes 6 horas.';

-- ---------------------------------------------------------------------------
-- 1. ai_data_quality() — la foto de qué tan confiable es la base
-- ---------------------------------------------------------------------------
-- La consume el tablero de readiness. No estima nada: cuenta lo que hay.

create or replace function ai_data_quality()
returns jsonb language sql stable security definer set search_path = public as $$
  with d as (
    select
      count(*)                                                as doctors_total,
      count(*) filter (where lifecycle_stage is not null)     as with_lifecycle,
      count(*) filter (where is_accredited)                   as accredited_total,
      count(*) filter (where accredited_at is not null)       as with_accreditation_date,
      count(*) filter (where is_accredited
                         and accredited_at is null)           as accredited_without_date,
      count(*) filter (where owner_id is not null)            as with_owner,
      count(*) filter (where clinical_owner_id is not null)   as with_clinical_owner,
      count(*) filter (where priority_bucket is null)         as without_priority_bucket
    from doctors where not is_demo
  ),
  c as (
    select
      count(*)                                                     as cases_total,
      count(*) filter (where case_subject_type <> 'UNKNOWN')       as cases_with_subject_type,
      count(*) filter (where case_subject_type = 'DOCTOR_SELF')    as cases_doctor_self,
      count(*) filter (where case_subject_type = 'PATIENT')        as cases_patient,
      count(*) filter (where case_subject_type = 'OTHER')          as cases_other
    from cases where not is_demo
  ),
  a as (
    select
      count(*)                                                     as activities_total,
      count(*) filter (where engagement_quality <> 'UNKNOWN')      as activities_classified,
      count(*) filter (where engagement_quality = 'MEANINGFUL')    as activities_meaningful,
      count(*) filter (where engagement_quality = 'LOW_TOUCH')     as activities_low_touch,
      count(distinct doctor_id) filter
        (where engagement_quality = 'MEANINGFUL')                  as doctors_with_meaningful
    from activities where not is_demo
  ),
  al as (
    select
      count(*)                                                     as open_service_alerts_total,
      count(*) filter (where service_confidence is null)           as needing_review,
      count(*) filter (where trust_risk_score is not null)         as with_trust_score
    from alerts
    where not is_demo and status = 'abierta'
      and rule_key in ('caso_atrasado', 'aprobacion_pendiente', 'oportunidad_estancada')
  ),
  o as (
    select
      count(*)                                                     as opportunities_total,
      count(*) filter (where viability_status is not null)         as with_viability_status
    from opportunities where not is_demo
  ),
  off as (
    select count(*) as commercial_offers_active
    from commercial_offers
    where active and (valid_to is null or valid_to >= ai_mx_today())
  )
  select jsonb_build_object(
    'doctors_total', d.doctors_total,
    'with_lifecycle', d.with_lifecycle,
    'with_accreditation_date', d.with_accreditation_date,
    'with_owner', d.with_owner,
    'with_clinical_owner', d.with_clinical_owner,
    'cases_total', c.cases_total,
    'cases_with_subject_type', c.cases_with_subject_type,
    'activities_total', a.activities_total,
    'activities_classified', a.activities_classified,
    'doctors_with_reliable_last_meaningful_contact', a.doctors_with_meaningful,
    'open_service_alerts_needing_review', al.needing_review,
    -- contexto para leer los números de arriba sin sacar conclusiones de más
    'detalle', jsonb_build_object(
      'doctors_accredited', d.accredited_total,
      'doctors_accredited_without_date', d.accredited_without_date,
      'doctors_without_priority_bucket', d.without_priority_bucket,
      'cases_doctor_self', c.cases_doctor_self,
      'cases_patient', c.cases_patient,
      'cases_other', c.cases_other,
      'cases_unknown_subject', c.cases_total - c.cases_with_subject_type,
      'activities_meaningful', a.activities_meaningful,
      'activities_low_touch', a.activities_low_touch,
      'activities_unknown', a.activities_total - a.activities_classified,
      'open_service_alerts_total', al.open_service_alerts_total,
      'open_service_alerts_with_trust_score', al.with_trust_score,
      'opportunities_total', o.opportunities_total,
      'opportunities_with_viability_status', o.with_viability_status,
      'commercial_offers_active', off.commercial_offers_active
    ),
    'porcentajes', jsonb_build_object(
      'cases_with_subject_type', case when c.cases_total = 0 then null
        else round(100.0 * c.cases_with_subject_type / c.cases_total, 1) end,
      'activities_classified', case when a.activities_total = 0 then null
        else round(100.0 * a.activities_classified / a.activities_total, 1) end,
      'doctors_with_owner', case when d.doctors_total = 0 then null
        else round(100.0 * d.with_owner / d.doctors_total, 1) end,
      'accredited_with_date', case when d.accredited_total = 0 then null
        else round(100.0 * d.with_accreditation_date / d.accredited_total, 1) end
    ),
    'rows_considered', d.doctors_total + c.cases_total + a.activities_total
                       + al.open_service_alerts_total + o.opportunities_total,
    'notas', jsonb_build_array(
      'doctors.lifecycle_stage es NOT NULL con default prospecto: cobertura 100% es estructural, no evidencia de que alguien lo haya calificado.',
      'contacto significativo confiable = actividad con engagement_quality=MEANINGFUL cargada por humano o regla; el tipo de actividad NO alcanza.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when c.cases_with_subject_type = 0
          then 'ningún caso tiene case_subject_type clasificado: no se puede distinguir caso propio del doctor de primer caso de paciente.' end as x
        union all
        select case when a.activities_classified = 0
          then 'ninguna actividad tiene engagement_quality clasificada: el reloj de contacto significativo no tiene con qué funcionar.' end
        union all
        select case when off.commercial_offers_active = 0
          then 'no hay ofertas comerciales vigentes configuradas: no se puede mencionar ningún descuento ni incentivo.' end
        union all
        select case when d.with_owner < d.doctors_total
          then (d.doctors_total - d.with_owner) || ' doctores sin owner asignado: los cortes por persona no cubren la base entera.' end
      ) t where x is not null
    )
  )
  from d, c, a, al, o, off
$$;

comment on function ai_data_quality() is
  'Cobertura real de los campos que sostienen las conclusiones de la capa AI. '
  'Sin inferencias: lo no clasificado se cuenta como no clasificado.';

-- ---------------------------------------------------------------------------
-- 2. ai_pipeline_summary(p_period, p_limit) — pipeline + tira de forecast
-- ---------------------------------------------------------------------------

create or replace function ai_pipeline_summary(p_period date default null, p_limit int default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  with per as (
    select coalesce(date_trunc('month', p_period)::date, ai_mx_month_start()) as m,
           greatest(1, least(coalesce(p_limit, 50), 200)) as n
  ),
  open_opps as (
    select o.id, o.patient_name, o.stage::text as stage, o.stage_entered_at,
           o.probability, o.amount_mxn, o.forecast_category::text as forecast_category,
           o.expected_close_date, d.id as doctor_id, d.nombre as doctor
    from opportunities o
    join doctors d on d.id = o.doctor_id
    where not o.is_demo and o.stage not in ('ganada', 'perdida')
  ),
  agg as (
    select count(*)                                              as total,
           count(*) filter (where forecast_category = 'commit')     as commit_n,
           count(*) filter (where forecast_category = 'best_case')  as best_n,
           count(*) filter (where forecast_category = 'pipeline')   as pipe_n,
           count(*) filter (where probability is null)              as sin_probabilidad,
           coalesce(sum(probability), 0) / 100.0                    as weighted,
           coalesce(sum(amount_mxn), 0)                             as monto
    from open_opps
  ),
  cerradas as (
    select count(*) filter (where o.stage = 'ganada')  as ganadas,
           count(*) filter (where o.stage = 'perdida') as perdidas
    from opportunities o, per
    where not o.is_demo and o.stage in ('ganada', 'perdida')
      and o.closed_at is not null
      and ai_mx_date(o.closed_at) >= per.m
      and ai_mx_date(o.closed_at) < (per.m + interval '1 month')::date
  ),
  nuevos as (
    select count(*) as n
    from cases c, per
    where not c.is_demo and c.is_new_case
      and ai_mx_date(c.fecha_ingreso) >= per.m
      and ai_mx_date(c.fecha_ingreso) < (per.m + interval '1 month')::date
  ),
  pagados as (
    select count(*) as n
    from payments p, per
    where not p.is_demo and p.paid_at >= per.m
      and p.paid_at < (per.m + interval '1 month')::date
  ),
  lista as (
    select coalesce(jsonb_agg(item), '[]'::jsonb) as items, count(*) as listadas
    from (
      select jsonb_build_object(
               'id', o.id,
               'doctor', o.doctor,
               'doctor_id', o.doctor_id,
               'paciente', o.patient_name,
               'etapa', o.stage,
               'dias_en_etapa', ai_mx_today() - ai_mx_date(o.stage_entered_at),
               'probabilidad', o.probability,
               'monto_mxn', o.amount_mxn,
               'forecast_category', o.forecast_category,
               'cierre_esperado', o.expected_close_date
             ) as item
      from open_opps o, per
      order by o.stage_entered_at asc
      limit (select n from per)
    ) t
  )
  select jsonb_build_object(
    'mes', to_char(per.m, 'YYYY-MM'),
    'objetivo_casos_pagados', (select g.target from goals g
                               where g.period = per.m and g.metric = 'paid_cases'
                                 and g.user_id is null limit 1),
    'casos_nuevos_mes', nuevos.n,
    'casos_pagados_mes_ledger', pagados.n,
    'pipeline_ponderado', round(agg.weighted, 1),
    'forecast_casos_nuevos', nuevos.n + round(agg.weighted)::int,
    'gap_vs_objetivo', (
      select case when g.target is null then null
             else g.target - (nuevos.n + round(agg.weighted)::int) end
      from (select (select target from goals gg
                    where gg.period = per.m and gg.metric = 'paid_cases'
                      and gg.user_id is null limit 1) as target) g
    ),
    'oportunidades_abiertas_total', agg.total,
    'monto_abierto_mxn', agg.monto,
    'commit', agg.commit_n,
    'best_case', agg.best_n,
    'pipeline', agg.pipe_n,
    'ganadas_mes', cerradas.ganadas,
    'perdidas_mes', cerradas.perdidas,
    'oportunidades', lista.items,
    'oportunidades_listadas', lista.listadas,
    'orden_lista', 'más días en etapa primero',
    'rows_considered', agg.total,
    'notas', jsonb_build_array(
      'el objetivo del mes es de CASOS PAGADOS (ledger payments) y el forecast se arma con casos NUEVOS (cases.is_new_case): son métricas distintas, no las mezcles en una sola frase.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when lista.listadas < agg.total
          then 'la lista muestra ' || lista.listadas || ' de ' || agg.total || ' oportunidades abiertas.' end as x
        union all
        select case when agg.sin_probabilidad > 0
          then agg.sin_probabilidad || ' oportunidades abiertas sin probabilidad cargada: cuentan 0 en el pipeline ponderado (el forecast queda subestimado, no estimado).' end
      ) t where x is not null
    )
  )
  from per, agg, cerradas, nuevos, pagados, lista
$$;

-- ---------------------------------------------------------------------------
-- 3. ai_forecast(p_period) — sin el detalle de oportunidades
-- ---------------------------------------------------------------------------

create or replace function ai_forecast(p_period date default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with per as (
    select coalesce(date_trunc('month', p_period)::date, ai_mx_month_start()) as m
  ),
  opp as (
    select count(*)                                   as abiertas,
           count(*) filter (where probability is null) as sin_probabilidad,
           coalesce(sum(probability), 0) / 100.0       as weighted
    from opportunities where not is_demo and stage not in ('ganada', 'perdida')
  ),
  nuevos as (
    select count(*) as n from cases c, per
    where not c.is_demo and c.is_new_case
      and ai_mx_date(c.fecha_ingreso) >= per.m
      and ai_mx_date(c.fecha_ingreso) < (per.m + interval '1 month')::date
  ),
  pagados as (
    select count(*) as n from payments p, per
    where not p.is_demo and p.paid_at >= per.m
      and p.paid_at < (per.m + interval '1 month')::date
  ),
  acred as (
    select count(*) as n from doctors d, per
    where not d.is_demo and d.accredited_at >= per.m
      and d.accredited_at < (per.m + interval '1 month')::date
  ),
  metas as (
    select (select target from goals g where g.period = per.m and g.metric = 'paid_cases'
              and g.user_id is null limit 1) as paid_cases,
           (select target from goals g where g.period = per.m and g.metric = 'accreditations'
              and g.user_id is null limit 1) as accreditations
    from per
  )
  select jsonb_build_object(
    'mes', to_char(per.m, 'YYYY-MM'),
    'objetivo_casos_pagados', metas.paid_cases,
    'casos_nuevos_mes', nuevos.n,
    'casos_pagados_mes_ledger', pagados.n,
    'pipeline_ponderado', round(opp.weighted, 1),
    'oportunidades_abiertas', opp.abiertas,
    'forecast_casos_nuevos', nuevos.n + round(opp.weighted)::int,
    'gap_vs_objetivo', case when metas.paid_cases is null then null
                        else metas.paid_cases - (nuevos.n + round(opp.weighted)::int) end,
    'objetivo_acreditaciones', metas.accreditations,
    'acreditados_mes', acred.n,
    'rows_considered', opp.abiertas + nuevos.n + pagados.n + acred.n,
    'notas', jsonb_build_array(
      'objetivo = casos PAGADOS (ledger payments); forecast = casos NUEVOS (cases.is_new_case). Son dos métricas distintas.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when metas.paid_cases is null
          then 'no hay objetivo de casos pagados cargado para ' || to_char(per.m, 'YYYY-MM') || ': el gap no se puede calcular.' end as x
        union all
        select case when metas.accreditations is null
          then 'no hay objetivo de acreditaciones cargado para ' || to_char(per.m, 'YYYY-MM') || '.' end
        union all
        select case when opp.sin_probabilidad > 0
          then opp.sin_probabilidad || ' oportunidades abiertas sin probabilidad: pesan 0 en el pipeline ponderado.' end
      ) t where x is not null
    )
  )
  from per, opp, nuevos, pagados, acred, metas
$$;

-- ---------------------------------------------------------------------------
-- 4. ai_doctor_segments() — la base entera segmentada, sin perder filas
-- ---------------------------------------------------------------------------
-- Enumera los labels del enum (no una lista hardcodeada en TS que se desactualiza)
-- y cuenta aparte los null, para que la suma de los cortes SIEMPRE dé el total.

create or replace function ai_doctor_segments()
returns jsonb language sql stable security definer set search_path = public as $$
  with base as (select * from doctors where not is_demo),
  tot as (
    select count(*) as total,
           count(*) filter (where not is_accredited) as universo_a,
           count(*) filter (where is_accredited)     as universo_b
    from base
  ),
  lc as (
    select jsonb_object_agg(l.label::text, coalesce(c.n, 0)) as j
    from unnest(enum_range(null::lifecycle_stage)) as l(label)
    left join (select lifecycle_stage, count(*) n from base group by 1) c
      on c.lifecycle_stage = l.label
  ),
  bk as (
    select jsonb_object_agg(b.label, coalesce(c.n, 0)) as j
    from (values ('critico'), ('alto_impacto'), ('seguimientos'), ('oportunidades'),
                 ('riesgo'), ('growth'), ('nuevo_negocio'), ('activacion')) as b(label)
    left join (select priority_bucket, count(*) n from base
               where priority_bucket is not null group by 1) c
      on c.priority_bucket = b.label
  ),
  bk_null as (select count(*) as n from base where priority_bucket is null),
  cat as (
    select jsonb_object_agg(k.label::text, coalesce(c.n, 0)) as j
    from unnest(enum_range(null::doctor_categoria)) as k(label)
    left join (select categoria, count(*) n from base group by 1) c on c.categoria = k.label
  ),
  acq as (
    select jsonb_object_agg(s.label::text, coalesce(c.n, 0)) as j
    from unnest(enum_range(null::acq_stage)) as s(label)
    left join (select acquisition_stage, count(*) n from base
               where not is_accredited and acquisition_stage is not null group by 1) c
      on c.acquisition_stage = s.label
  ),
  acq_null as (select count(*) as n from base where not is_accredited and acquisition_stage is null),
  act as (
    select jsonb_object_agg(s.label::text, coalesce(c.n, 0)) as j
    from unnest(enum_range(null::act_stage)) as s(label)
    left join (select activation_stage, count(*) n from base
               where is_accredited and activation_stage is not null group by 1) c
      on c.activation_stage = s.label
  ),
  act_null as (select count(*) as n from base where is_accredited and activation_stage is null)
  select jsonb_build_object(
    'total', tot.total,
    'universo_A_no_acreditados', tot.universo_a,
    'universo_B_acreditados', tot.universo_b,
    'por_lifecycle', lc.j,
    'por_priority_bucket', bk.j || jsonb_build_object('(sin bucket calculado)', bk_null.n),
    'por_categoria', cat.j,
    'por_acquisition_stage_universo_A', acq.j || jsonb_build_object('(sin etapa)', acq_null.n),
    'por_activation_stage_universo_B', act.j || jsonb_build_object('(sin etapa)', act_null.n),
    'rows_considered', tot.total,
    'notas', jsonb_build_array(
      'los cortes enumeran TODOS los labels del enum (incluidos los que dan 0) y los null van a su propia clave: la suma de cada corte da siempre el total.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when bk_null.n > 0
          then bk_null.n || ' doctores sin priority_bucket calculado (recompute_doctor todavía no corrió sobre ellos): están en el total pero no en ningún bucket.' end as x
      ) t where x is not null
    )
  )
  from tot, lc, bk, bk_null, cat, acq, acq_null, act, act_null
$$;

-- ---------------------------------------------------------------------------
-- 5. ai_cases_by_period(p_from, p_to) — tendencia de casos nuevos
-- ---------------------------------------------------------------------------

create or replace function ai_cases_by_period(p_from date, p_to date default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with rango as (select p_from as f, coalesce(p_to, ai_mx_today()) as t),
  todos as (
    select c.id, c.doctor_id, c.is_new_case, ai_mx_date(c.fecha_ingreso) as dt
    from cases c, rango
    where not c.is_demo
      and ai_mx_date(c.fecha_ingreso) >= rango.f
      and ai_mx_date(c.fecha_ingreso) <= rango.t
  ),
  nuevos as (select * from todos where is_new_case),
  mes as (
    select coalesce(jsonb_object_agg(m, n order by m), '{}'::jsonb) as j
    from (select to_char(dt, 'YYYY-MM') as m, count(*) as n from nuevos group by 1) x
  ),
  top as (
    select coalesce(jsonb_agg(item order by casos desc), '[]'::jsonb) as j, count(*) as listados
    from (
      select d.id, d.nombre, count(*) as casos,
             jsonb_build_object('doctor_id', d.id, 'doctor', d.nombre, 'casos', count(*)) as item
      from nuevos n join doctors d on d.id = n.doctor_id
      group by d.id, d.nombre
      order by count(*) desc, d.nombre
      limit 15
    ) t
  ),
  docs as (select count(distinct doctor_id) as n from nuevos)
  select jsonb_build_object(
    'desde', rango.f,
    'hasta', rango.t,
    'casos_nuevos_total', (select count(*) from nuevos),
    'casos_todas_las_etapas', (select count(*) from todos),
    'por_mes', mes.j,
    'doctores_distintos', docs.n,
    'top_doctores', top.j,
    'top_doctores_listados', top.listados,
    'rows_considered', (select count(*) from todos),
    'notas', jsonb_build_array(
      'casos_nuevos_total cuenta SOLO 1ª etapa (cases.is_new_case, la regla del KPI). casos_todas_las_etapas incluye refinamientos: sumarlas sería doble conteo.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when docs.n > top.listados
          then 'top_doctores muestra ' || top.listados || ' de ' || docs.n || ' doctores con casos nuevos en el período.' end as x
      ) t where x is not null
    )
  )
  from rango, mes, top, docs
$$;

-- ---------------------------------------------------------------------------
-- 6. ai_rep_performance(p_days, p_period) — desempeño del equipo
-- ---------------------------------------------------------------------------

create or replace function ai_rep_performance(p_days int default 30, p_period date default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with per as (
    select coalesce(date_trunc('month', p_period)::date, ai_mx_month_start()) as m,
           greatest(1, least(coalesce(p_days, 30), 365)) as d
  ),
  equipo as (select id, nombre, rol::text as rol from profiles where activo),
  casos as (
    select d.owner_id, count(*) as n
    from cases c join doctors d on d.id = c.doctor_id, per
    where not c.is_demo and c.is_new_case and d.owner_id is not null
      and ai_mx_date(c.fecha_ingreso) >= per.m
      and ai_mx_date(c.fecha_ingreso) < (per.m + interval '1 month')::date
    group by d.owner_id
  ),
  casos_sin_owner as (
    select count(*) as n
    from cases c join doctors d on d.id = c.doctor_id, per
    where not c.is_demo and c.is_new_case and d.owner_id is null
      and ai_mx_date(c.fecha_ingreso) >= per.m
      and ai_mx_date(c.fecha_ingreso) < (per.m + interval '1 month')::date
  ),
  opps as (
    select owner_id, count(*) as n from opportunities
    where not is_demo and stage not in ('ganada', 'perdida') and owner_id is not null
    group by owner_id
  ),
  opps_sin_owner as (
    select count(*) as n from opportunities
    where not is_demo and stage not in ('ganada', 'perdida') and owner_id is null
  ),
  acts as (
    select a.created_by, count(*) as n,
           count(*) filter (where a.type = 'visita')  as visitas,
           count(*) filter (where a.type = 'keepday') as keepdays,
           count(*) filter (where a.engagement_quality = 'MEANINGFUL') as significativas
    from activities a, per
    where not a.is_demo and a.created_by is not null
      and a.occurred_at >= now() - make_interval(days => per.d)
    group by a.created_by
  ),
  acts_sin_autor as (
    select count(*) as n from activities a, per
    where not a.is_demo and a.created_by is null
      and a.occurred_at >= now() - make_interval(days => per.d)
  ),
  vencidas as (
    select assigned_to, count(*) as n from tasks
    where not is_demo and status = 'pendiente' and assigned_to is not null
      and due_date < ai_mx_today()
    group by assigned_to
  ),
  metas as (
    select g.user_id, g.target from goals g, per
    where g.period = per.m and g.metric = 'paid_cases' and g.user_id is not null
  ),
  filas as (
    select coalesce(jsonb_agg(item order by casos desc, persona), '[]'::jsonb) as j,
           count(*) as n
    from (
      select e.nombre as persona,
             coalesce(c.n, 0) as casos,
             jsonb_build_object(
               'persona', e.nombre,
               'rol', e.rol,
               'casos_nuevos_mes', coalesce(c.n, 0),
               'objetivo_casos', mt.target,
               'opps_abiertas', coalesce(o.n, 0),
               'actividades_periodo', coalesce(a.n, 0),
               'actividades_significativas', coalesce(a.significativas, 0),
               'visitas_periodo', coalesce(a.visitas, 0),
               'keepdays_periodo', coalesce(a.keepdays, 0),
               'tareas_vencidas', coalesce(v.n, 0)
             ) as item
      from equipo e
      left join casos c on c.owner_id = e.id
      left join opps o on o.owner_id = e.id
      left join acts a on a.created_by = e.id
      left join vencidas v on v.assigned_to = e.id
      left join metas mt on mt.user_id = e.id
    ) t
  )
  select jsonb_build_object(
    'mes', to_char(per.m, 'YYYY-MM'),
    'ventana_actividades_dias', per.d,
    'equipo', filas.j,
    'personas_activas', filas.n,
    'casos_nuevos_mes_sin_owner', casos_sin_owner.n,
    'actividades_periodo_sin_autor', acts_sin_autor.n,
    'opps_abiertas_sin_owner', opps_sin_owner.n,
    -- totales de control: la suma por persona + lo no atribuible debe dar esto
    'totales_periodo', jsonb_build_object(
      'casos_nuevos_mes', coalesce((select sum(n) from casos), 0) + casos_sin_owner.n,
      'opps_abiertas', coalesce((select sum(n) from opps), 0) + opps_sin_owner.n,
      'actividades', coalesce((select sum(n) from acts), 0) + acts_sin_autor.n,
      'tareas_vencidas', coalesce((select sum(n) from vencidas), 0)
    ),
    'rows_considered', coalesce((select sum(n) from casos), 0) + casos_sin_owner.n
                       + coalesce((select sum(n) from opps), 0) + opps_sin_owner.n
                       + coalesce((select sum(n) from acts), 0) + acts_sin_autor.n
                       + coalesce((select sum(n) from vencidas), 0),
    'notas', jsonb_build_array(
      'actividades_significativas cuenta solo engagement_quality=MEANINGFUL; el resto queda UNKNOWN y no se asume ni a favor ni en contra.',
      'casos_nuevos_mes se atribuye por doctors.owner_id (dueño actual del doctor), no por quién cargó el caso.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when casos_sin_owner.n > 0
          then casos_sin_owner.n || ' casos nuevos del mes son de doctores SIN owner: no están en el desglose por persona.' end as x
        union all
        select case when acts_sin_autor.n > 0
          then acts_sin_autor.n || ' actividades del período sin created_by (importadas): no se le atribuyen a nadie.' end
        union all
        select case when opps_sin_owner.n > 0
          then opps_sin_owner.n || ' oportunidades abiertas sin owner: no están en el desglose por persona (por eso la suma no da el total del pipeline).' end
      ) t where x is not null
    )
  )
  from per, filas, casos_sin_owner, acts_sin_autor, opps_sin_owner
$$;

-- ---------------------------------------------------------------------------
-- 7. Listas de segmentos: top-N + total real
-- ---------------------------------------------------------------------------

create or replace function ai_at_risk_doctors(p_limit int default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  with lim as (select greatest(1, least(coalesce(p_limit, 50), 200)) as n),
  base as (
    select d.* from doctors d
    where not d.is_demo
      and (d.lifecycle_stage = 'en_riesgo' or d.priority_bucket in ('riesgo', 'critico'))
  ),
  alertas as (
    select doctor_id, count(*) as n, (array_agg(title order by created_at desc))[1:3] as titles
    from alerts where not is_demo and status = 'abierta' and doctor_id is not null
    group by doctor_id
  ),
  lista as (
    select coalesce(jsonb_agg(item), '[]'::jsonb) as j, count(*) as n
    from (
      select jsonb_build_object(
               'doctor_id', b.id,
               'nombre', b.nombre,
               'city', b.city,
               'categoria', b.categoria::text,
               'lifecycle', b.lifecycle_stage::text,
               'bucket', b.priority_bucket,
               'prioridad', b.priority_score,
               'health', b.health_score,
               'casos_historicos', b.new_case_count,
               'dias_sin_caso_nuevo', case when b.last_new_case_at is null then null
                                       else ai_mx_today() - b.last_new_case_at end,
               'ritmo_dias', round(b.avg_interval_days)::int,
               'owner', p.nombre,
               'alertas_abiertas', coalesce(to_jsonb(a.titles), '[]'::jsonb)
             ) as item
      from base b
      left join profiles p on p.id = b.owner_id
      left join alertas a on a.doctor_id = b.id
      order by b.priority_score desc nulls last, b.nombre
      limit (select n from lim)
    ) t
  )
  select jsonb_build_object(
    'doctores', lista.j,
    'listados', lista.n,
    'total_en_riesgo', (select count(*) from base),
    'criterio', 'lifecycle_stage=en_riesgo o priority_bucket in (riesgo, critico)',
    'rows_considered', (select count(*) from base),
    'notas', jsonb_build_array(
      'alertas_abiertas trae hasta 3 títulos de TODAS las alertas abiertas del doctor, no solo las de servicio.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when lista.n < (select count(*) from base)
          then 'lista capada: ' || lista.n || ' de ' || (select count(*) from base) || ' doctores en riesgo, ordenados por priority_score.' end as x
      ) t where x is not null
    )
  )
  from lista
$$;

create or replace function ai_dormant_doctors(p_limit int default 50, p_include_lost boolean default true)
returns jsonb language sql stable security definer set search_path = public as $$
  with lim as (select greatest(1, least(coalesce(p_limit, 50), 200)) as n),
  base as (
    select d.* from doctors d
    where not d.is_demo and d.is_accredited
      and (d.lifecycle_stage = 'dormido'
           or (coalesce(p_include_lost, true) and d.lifecycle_stage = 'perdido'))
  ),
  lista as (
    select coalesce(jsonb_agg(item), '[]'::jsonb) as j, count(*) as n
    from (
      select jsonb_build_object(
               'doctor_id', b.id,
               'nombre', b.nombre,
               'city', b.city,
               'categoria', b.categoria::text,
               'lifecycle', b.lifecycle_stage::text,
               'casos_historicos', b.new_case_count,
               'ultimo_caso', b.last_new_case_at,
               'dias_sin_caso_nuevo', case when b.last_new_case_at is null then null
                                       else ai_mx_today() - b.last_new_case_at end,
               'recuperable_365d', case when b.last_new_case_at is null then null
                                    else (ai_mx_today() - b.last_new_case_at) <= 365 end,
               'ritmo_dias', round(b.avg_interval_days)::int,
               'motivo_perdida', b.lost_reason,
               'owner', p.nombre
             ) as item
      from base b
      left join profiles p on p.id = b.owner_id
      order by b.last_new_case_at desc nulls last, b.nombre
      limit (select n from lim)
    ) t
  )
  select jsonb_build_object(
    'doctores', lista.j,
    'listados', lista.n,
    'total_dormidos_o_perdidos', (select count(*) from base),
    'incluye_perdidos', coalesce(p_include_lost, true),
    'criterio', case when coalesce(p_include_lost, true)
                 then 'acreditados con lifecycle dormido o perdido'
                 else 'acreditados con lifecycle dormido (los perdidos quedan afuera)' end,
    'sin_fecha_de_ultimo_caso', (select count(*) from base where last_new_case_at is null),
    'rows_considered', (select count(*) from base),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when lista.n < (select count(*) from base)
          then 'lista capada: ' || lista.n || ' de ' || (select count(*) from base)
               || case when coalesce(p_include_lost, true) then ' doctores dormidos/perdidos.'
                       else ' doctores dormidos (sin contar los perdidos).' end end as x
        union all
        select case when (select count(*) from base where last_new_case_at is null) > 0
          then (select count(*) from base where last_new_case_at is null) || ' sin fecha de último caso: dias_sin_caso_nuevo y recuperable_365d quedan en null, NO en 0.' end
      ) t where x is not null
    )
  )
  from lista
$$;

create or replace function ai_accredited_not_activated(p_limit int default 50)
returns jsonb language sql stable security definer set search_path = public as $$
  with lim as (select greatest(1, least(coalesce(p_limit, 50), 200)) as n),
  base as (
    select d.* from doctors d
    where not d.is_demo and d.is_accredited and d.new_case_count = 0
  ),
  lista as (
    select coalesce(jsonb_agg(item), '[]'::jsonb) as j, count(*) as n
    from (
      select jsonb_build_object(
               'doctor_id', b.id,
               'nombre', b.nombre,
               'city', b.city,
               'categoria', b.categoria::text,
               'lifecycle', b.lifecycle_stage::text,
               'etapa_activacion', b.activation_stage::text,
               'acreditado', b.accredited_at,
               'dias_desde_acreditacion', case when b.accredited_at is null then null
                                           else ai_mx_today() - b.accredited_at end,
               'casos_estimados_mes', b.estimated_cases_month,
               'casos_totales_incluye_refinamientos', b.case_count,
               'owner', p.nombre
             ) as item
      from base b
      left join profiles p on p.id = b.owner_id
      order by b.accredited_at asc nulls last, b.nombre
      limit (select n from lim)
    ) t
  )
  select jsonb_build_object(
    'doctores', lista.j,
    'listados', lista.n,
    'total_acreditados_sin_caso_nuevo', (select count(*) from base),
    'total_acreditados', (select count(*) from doctors where not is_demo and is_accredited),
    'sin_fecha_de_acreditacion', (select count(*) from base where accredited_at is null),
    'rows_considered', (select count(*) from base),
    'notas', jsonb_build_array(
      'new_case_count=0 significa sin caso de 1ª etapa. Con case_subject_type todo en UNKNOWN no se puede afirmar si hubo caso propio del doctor.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when lista.n < (select count(*) from base)
          then 'lista capada: ' || lista.n || ' de ' || (select count(*) from base) || ' acreditados sin caso nuevo.' end as x
        union all
        select case when (select count(*) from base where accredited_at is null) > 0
          then (select count(*) from base where accredited_at is null) || ' sin fecha de acreditación: van al final del orden y su día 75 no se puede calcular.' end
      ) t where x is not null
    )
  )
  from lista
$$;

create or replace function ai_prospects(
  p_stage text default null,
  p_limit int default 50,
  p_city text default null,
  p_source text default null,
  p_min_interest int default null
)
returns jsonb language sql stable security definer set search_path = public as $$
  with lim as (select greatest(1, least(coalesce(p_limit, 50), 200)) as n),
  base as (
    select d.* from doctors d
    where not d.is_demo and not d.is_accredited
      and (p_stage is null or d.acquisition_stage = p_stage::acq_stage)
      and (p_city is null or d.city ilike '%' || p_city || '%')
      and (p_source is null or d.source::text = p_source)
      and (p_min_interest is null or d.interest_level >= p_min_interest)
  ),
  lista as (
    select coalesce(jsonb_agg(item), '[]'::jsonb) as j, count(*) as n
    from (
      select jsonb_build_object(
               'doctor_id', b.id,
               'nombre', b.nombre,
               'city', b.city,
               'fuente', b.source::text,
               'etapa_adquisicion', b.acquisition_stage::text,
               'interes', b.interest_level,
               'interes_acreditacion', b.accreditation_interest,
               'casos_estimados_mes', b.estimated_cases_month,
               'usa_alineadores', b.uses_aligners,
               'prioridad', b.priority_score,
               'dias_sin_contacto', case when b.last_contact_at is null then null
                                     else ai_mx_today() - ai_mx_date(b.last_contact_at) end,
               'owner', p.nombre
             ) as item
      from base b
      left join profiles p on p.id = b.owner_id
      order by b.priority_score desc nulls last, b.nombre
      limit (select n from lim)
    ) t
  )
  select jsonb_build_object(
    'doctores', lista.j,
    'listados', lista.n,
    'total_que_cumplen_el_filtro', (select count(*) from base),
    'total_universo_A', (select count(*) from doctors where not is_demo and not is_accredited),
    'filtros', jsonb_build_object('stage', p_stage, 'city', p_city, 'source', p_source,
                                  'min_interest', p_min_interest),
    'sin_contacto_registrado', (select count(*) from base where last_contact_at is null),
    'rows_considered', (select count(*) from base),
    'notas', jsonb_build_array(
      'ausencia de last_contact_at NO es ausencia de contacto: el equipo todavía no registra sus contactos en el CRM.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when lista.n < (select count(*) from base)
          then 'lista capada: ' || lista.n || ' de ' || (select count(*) from base) || ' prospectos que cumplen el filtro, ordenados por priority_score.' end as x
        union all
        select case when (select count(*) from base where last_contact_at is null) > 0
          then (select count(*) from base where last_contact_at is null) || ' prospectos sin last_contact_at: dias_sin_contacto queda en null, no en 0.' end
      ) t where x is not null
    )
  )
  from lista
$$;

-- ---------------------------------------------------------------------------
-- 8. ai_service_issues(p_limit, p_doctor_id) — servicio antes que comercial
-- ---------------------------------------------------------------------------
-- El filtro de >7 días se aplica ANTES del cap (la versión vieja capaba a 50 y
-- recién después filtraba: podía perder casos atrasados sin decirlo).

create or replace function ai_service_issues(p_limit int default 50, p_doctor_id uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with lim as (select greatest(1, least(coalesce(p_limit, 50), 200)) as n),
  al as (
    select a.rule_key, a.severity::text as severity, a.title, a.reason, a.created_at,
           a.doctor_id, d.nombre as doctor, a.service_confidence, a.trust_risk_score
    from alerts a left join doctors d on d.id = a.doctor_id
    where not a.is_demo and a.status = 'abierta'
      and a.rule_key in ('caso_atrasado', 'aprobacion_pendiente', 'oportunidad_estancada')
      and (p_doctor_id is null or a.doctor_id = p_doctor_id)
  ),
  cs as (
    select c.id, coalesce(c.id_externo, c.noloco_case_id) as caso, c.etapa, c.paciente,
           c.doctor_id, d.nombre as doctor,
           ai_mx_today() - ai_mx_date(c.fecha_video) as dias
    from cases c join doctors d on d.id = c.doctor_id
    where not c.is_demo and c.fecha_video is not null
      and c.fecha_aprobacion_video is null and c.fecha_finalizado is null
      and (p_doctor_id is null or c.doctor_id = p_doctor_id)
      and ai_mx_today() - ai_mx_date(c.fecha_video) > 7
  ),
  lista_al as (
    select coalesce(jsonb_agg(item), '[]'::jsonb) as j, count(*) as n
    from (
      select jsonb_build_object(
               'regla', al.rule_key, 'severidad', al.severity, 'titulo', al.title,
               'motivo', al.reason, 'desde', ai_mx_date(al.created_at),
               'doctor_id', al.doctor_id, 'doctor', al.doctor,
               'confianza_servicio', al.service_confidence,
               'riesgo_confianza', al.trust_risk_score
             ) as item
      from al order by al.created_at desc limit (select n from lim)
    ) t
  ),
  lista_cs as (
    select coalesce(jsonb_agg(item), '[]'::jsonb) as j, count(*) as n
    from (
      select jsonb_build_object(
               'caso', cs.caso, 'etapa', cs.etapa, 'paciente', cs.paciente,
               'dias_sin_aprobar', cs.dias, 'doctor_id', cs.doctor_id, 'doctor', cs.doctor
             ) as item
      from cs order by cs.dias desc limit (select n from lim)
    ) t
  )
  select jsonb_build_object(
    'alertas', lista_al.j,
    'alertas_listadas', lista_al.n,
    'alertas_total', (select count(*) from al),
    'alertas_sin_calificar_impacto', (select count(*) from al where service_confidence is null),
    'casos_video_sin_aprobar', lista_cs.j,
    'casos_video_listados', lista_cs.n,
    'casos_video_total', (select count(*) from cs),
    'doctores_afectados', (select count(distinct doctor_id) from (
        select doctor_id from al where doctor_id is not null
        union select doctor_id from cs) u),
    'rows_considered', (select count(*) from al) + (select count(*) from cs),
    'notas', jsonb_build_array(
      'las alertas de caso_atrasado/aprobacion_pendiente pueden solaparse con casos_video_sin_aprobar: NO sumar las dos listas para contar problemas.',
      'el corte de video sin aprobar es > 7 días y se aplica ANTES del cap, así que casos_video_total es el total real.'
    ),
    'advertencias', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select case when lista_al.n < (select count(*) from al)
          then 'alertas capadas: ' || lista_al.n || ' de ' || (select count(*) from al) || '.' end as x
        union all
        select case when lista_cs.n < (select count(*) from cs)
          then 'casos con video sin aprobar capados: ' || lista_cs.n || ' de ' || (select count(*) from cs) || '.' end
        union all
        select case when (select count(*) from al where service_confidence is null) > 0
          then (select count(*) from al where service_confidence is null) || ' alertas sin service_confidence cargada: nadie calificó todavía si dañan la confianza del doctor. NO asumir que sí.' end
      ) t where x is not null
    )
  )
  from lista_al, lista_cs
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------

grant execute on function ai_mx_date(timestamptz)          to authenticated, service_role;
grant execute on function ai_mx_today()                    to authenticated, service_role;
grant execute on function ai_mx_month_start()              to authenticated, service_role;
grant execute on function ai_data_quality()                to authenticated, service_role;
grant execute on function ai_pipeline_summary(date, int)   to authenticated, service_role;
grant execute on function ai_forecast(date)                to authenticated, service_role;
grant execute on function ai_doctor_segments()             to authenticated, service_role;
grant execute on function ai_cases_by_period(date, date)   to authenticated, service_role;
grant execute on function ai_rep_performance(int, date)    to authenticated, service_role;
grant execute on function ai_at_risk_doctors(int)          to authenticated, service_role;
grant execute on function ai_dormant_doctors(int, boolean) to authenticated, service_role;
grant execute on function ai_accredited_not_activated(int) to authenticated, service_role;
grant execute on function ai_prospects(text, int, text, text, int) to authenticated, service_role;
grant execute on function ai_service_issues(int, uuid)     to authenticated, service_role;

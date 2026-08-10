-- 0005: motor de scores — Health / Potential / Priority con razones explicables
--
-- Arquitectura: funciones plpgsql que escriben columnas cacheadas en doctors.
-- recompute_doctor(id) por doctor; recompute_all() nightly (pg_cron) + botón manual.

-- intervalos por categoría (fallback para doctores con <3 casos nuevos)
create table cohort_intervals (
  categoria doctor_categoria primary key,
  median_interval numeric not null,
  updated_at timestamptz not null default now()
);
alter table cohort_intervals enable row level security;
create policy cohort_intervals_select on cohort_intervals
  for select to authenticated using (true);

create or replace function refresh_cohort_intervals() returns void
language sql security definer set search_path = public as $$
  insert into cohort_intervals (categoria, median_interval, updated_at)
  select d.categoria,
         percentile_cont(0.5) within group (order by p.pinterval),
         now()
  from (
    select doctor_id,
           greatest(14, least(365,
             percentile_cont(0.5) within group (order by gap_days))) as pinterval
    from (
      select doctor_id,
             extract(epoch from fecha_ingreso
               - lag(fecha_ingreso) over (partition by doctor_id order by fecha_ingreso)
             ) / 86400.0 as gap_days,
             row_number() over (partition by doctor_id order by fecha_ingreso desc) as rn
      from cases
      where is_new_case and not is_demo
    ) g
    where gap_days is not null and rn <= 8
    group by doctor_id
    having count(*) >= 2
  ) p
  join doctors d on d.id = p.doctor_id
  group by d.categoria
  on conflict (categoria) do update
    set median_interval = excluded.median_interval, updated_at = now();
$$;

-- Nota de diseño sobre is_demo: los CASOS demo se excluyen siempre (no deben tocar
-- el KPI), pero las actividades/oportunidades demo SÍ cuentan en los scores — el seed
-- las crea sobre doctores reales a propósito para que Hoy/pipeline se vean poblados
-- en la evaluación. purge_demo() las borra y recalcula, dejando los scores 100% reales.
create or replace function recompute_doctor(p_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  d record;
  -- casos
  v_case_count int; v_new_count int;
  v_first date; v_last date; v_last_new date;
  v_interval numeric; v_confidence text;
  v_overdue numeric := null;
  -- contacto
  v_last_contact timestamptz;
  v_contact_days numeric := null;
  -- momentum
  v_recent90 int; v_prior90 int;
  -- pipeline
  v_open_opps int; v_max_stage_rank int; v_max_prob int; v_open_amount numeric;
  v_p90_amount numeric;
  -- señales negativas
  v_lost90 boolean; v_critical_alert boolean;
  -- health
  h_freq numeric := 0; h_contact numeric := 0; h_momentum numeric := 0;
  h_pipeline numeric := 0; h_neg numeric := 10;
  v_health int;
  -- potential
  v_cat_pts numeric; v_capacity int; v_cap_pts numeric; v_lc_pts numeric;
  v_potential int;
  -- priority
  v_urgency numeric := 0; v_value numeric := 0; v_prob numeric := 0;
  v_decay numeric := 1.0; v_priority int;
  reasons jsonb := '[]'::jsonb;
  top_code text := null; top_weight numeric := -1;
  v_bucket text; v_action jsonb;
  -- opp estancada
  v_stalled record;
  v_stalled_found boolean := false;
  v_expected_days jsonb;
  -- tarea vencida
  v_overdue_task boolean;
begin
  perform set_config('app.system', 'on', true);

  select * into d from doctors where id = p_id;
  if not found then return; end if;

  -- ---------- stats de casos ----------
  select count(*),
         count(*) filter (where is_new_case),
         min(fecha_ingreso)::date,
         max(fecha_ingreso)::date,
         max(fecha_ingreso) filter (where is_new_case)
  into v_case_count, v_new_count, v_first, v_last, v_last_new
  from cases where doctor_id = p_id and not is_demo;

  -- ---------- intervalo esperado ----------
  if v_new_count >= 3 then
    select greatest(14, least(365,
      percentile_cont(0.5) within group (order by gap_days)))
    into v_interval
    from (
      select extract(epoch from fecha_ingreso
               - lag(fecha_ingreso) over (order by fecha_ingreso)) / 86400.0 as gap_days,
             row_number() over (order by fecha_ingreso desc) as rn
      from cases where doctor_id = p_id and is_new_case and not is_demo
    ) g
    where gap_days is not null and rn <= 8;
    v_confidence := 'personal';
  elsif v_new_count >= 1 then
    select median_interval into v_interval
    from cohort_intervals where categoria = d.categoria;
    v_interval := coalesce(v_interval, 45);
    v_confidence := 'cohort';
  else
    v_interval := null;
    v_confidence := 'insuficiente';
  end if;

  if v_last_new is not null and v_interval is not null then
    v_overdue := (current_date - v_last_new) / v_interval;
  end if;

  -- ---------- último contacto (actividad o cualquier movimiento de caso) ----------
  select greatest(
    (select max(occurred_at) from activities where doctor_id = p_id),
    (select max(fecha_ingreso) from cases where doctor_id = p_id and not is_demo)
  ) into v_last_contact;
  if v_last_contact is not null then
    v_contact_days := extract(epoch from now() - v_last_contact) / 86400.0;
  end if;

  -- ---------- momentum 90d vs 90d previos ----------
  select count(*) filter (where fecha_ingreso > now() - interval '90 days'),
         count(*) filter (where fecha_ingreso <= now() - interval '90 days'
                            and fecha_ingreso > now() - interval '180 days')
  into v_recent90, v_prior90
  from cases where doctor_id = p_id and is_new_case and not is_demo;

  -- ---------- pipeline abierto ----------
  select count(*),
         max(case stage
           when 'paciente_potencial' then 1 when 'documentacion' then 2
           when 'caso_ingresado' then 3 when 'planificacion' then 4
           when 'presentada' then 5 when 'decision' then 6
           when 'compromiso' then 7 else 0 end),
         max(probability),
         coalesce(sum(amount_mxn), 0)
  into v_open_opps, v_max_stage_rank, v_max_prob, v_open_amount
  from opportunities
  where doctor_id = p_id and stage not in ('ganada','perdida');

  select coalesce(nullif(percentile_cont(0.9) within group (order by s.total), 0), 1)
  into v_p90_amount
  from (
    select sum(coalesce(amount_mxn, 0)) as total
    from opportunities where stage not in ('ganada','perdida')
    group by doctor_id
  ) s;

  select exists(
    select 1 from opportunities
    where doctor_id = p_id and stage = 'perdida'
      and closed_at > now() - interval '90 days'
  ) into v_lost90;
  select exists(
    select 1 from alerts
    where doctor_id = p_id and status = 'abierta' and severity = 'critica'
  ) into v_critical_alert;

  -- ---------- HEALTH ----------
  if v_overdue is not null then
    h_freq := 40 * greatest(0, least(1, 2 - v_overdue));
  end if;
  if v_contact_days is not null then
    h_contact := case
      when v_contact_days <= 14 then 20
      when v_contact_days >= 60 then 0
      else 20 * (1 - (v_contact_days - 14) / 46.0)
    end;
  end if;
  h_momentum := case
    when v_prior90 = 0 and v_recent90 > 0 then 20
    when v_prior90 = 0 then 0
    when v_recent90::numeric / v_prior90 >= 1 then 20
    when v_recent90::numeric / v_prior90 <= 0.5 then 0
    else 20 * ((v_recent90::numeric / v_prior90) - 0.5) / 0.5
  end;
  h_pipeline := case
    when v_max_stage_rank >= 2 then 10
    when v_open_opps > 0 then 5
    else 0 end;
  h_neg := 10 - (case when v_lost90 then 5 else 0 end)
              - (case when v_critical_alert then 5 else 0 end);

  if v_confidence = 'insuficiente' then
    -- sin historial de casos: escala solo contacto + pipeline + negativos (máx 40)
    v_health := round((h_contact + h_pipeline + h_neg) * 100.0 / 40);
  else
    v_health := round(h_freq + h_contact + h_momentum + h_pipeline + h_neg);
  end if;
  v_health := greatest(0, least(100, v_health));

  -- ---------- POTENTIAL ----------
  v_cat_pts := case d.categoria
    when 'ELITE' then 90 when 'BLACK' then 80 when 'PLATINUM' then 75
    when 'GOLD' then 65 when 'SILVER' then 45 else 35 end;
  select coalesce(max(cnt), 0) into v_capacity
  from (
    select count(*) as cnt
    from cases c1
    join cases c2 on c2.doctor_id = c1.doctor_id
      and c2.is_new_case and not c2.is_demo
      and c2.fecha_ingreso >= c1.fecha_ingreso
      and c2.fecha_ingreso < c1.fecha_ingreso + interval '90 days'
    where c1.doctor_id = p_id and c1.is_new_case and not c1.is_demo
    group by c1.id
  ) w;
  v_cap_pts := least(100, v_capacity * 100.0 / 6);
  v_lc_pts := case d.lifecycle_stage
    when 'growth' then 80 when 'activo' then 60
    when 'dormido' then 30 when 'perdido' then 10
    else 50 end;
  v_potential := round(0.4 * v_cat_pts + 0.4 * v_cap_pts + 0.2 * v_lc_pts);

  -- ---------- señales de PRIORITY (con razones en español) ----------
  if v_overdue is not null and d.lifecycle_stage not in ('perdido') then
    if v_overdue >= 1.75 then
      reasons := reasons || jsonb_build_object('code', 'caso_muy_atrasado',
        'text', format('Lleva %s días sin caso nuevo (su ritmo: cada %s días)',
          current_date - v_last_new, round(v_interval)), 'weight', 1.0);
    elsif v_overdue >= 1.25 then
      reasons := reasons || jsonb_build_object('code', 'caso_atrasado',
        'text', format('Lleva %s días sin caso nuevo (su ritmo: cada %s días)',
          current_date - v_last_new, round(v_interval)), 'weight', 0.6);
    end if;
  end if;

  if d.lifecycle_stage in ('acreditado','acreditado_no_activado','en_activacion')
     and v_new_count = 0
     and coalesce(d.accredited_at, d.created_at::date) < current_date - 30 then
    reasons := reasons || jsonb_build_object('code', 'acreditado_no_activado',
      'text', format('Acreditado hace %s días y nunca mandó un caso',
        current_date - coalesce(d.accredited_at, d.created_at::date)), 'weight', 0.9);
  end if;

  -- oportunidad estancada (días esperados por etapa desde params de la regla)
  select coalesce(params->'expected_days', '{}'::jsonb) into v_expected_days
  from automation_rules where key = 'oportunidad_estancada';
  select o.patient_name, o.stage,
         extract(epoch from now() - o.stage_entered_at) / 86400.0 as days_in,
         coalesce((v_expected_days->>o.stage::text)::numeric,
           case o.stage
             when 'paciente_potencial' then 14 when 'documentacion' then 7
             when 'caso_ingresado' then 7 when 'planificacion' then 7
             when 'presentada' then 5 when 'decision' then 4
             when 'compromiso' then 7 else 7 end) as expected
  into v_stalled
  from opportunities o
  where o.doctor_id = p_id and o.stage not in ('ganada','perdida')
    and extract(epoch from now() - o.stage_entered_at) / 86400.0 >
        1.5 * coalesce((v_expected_days->>o.stage::text)::numeric,
           case o.stage
             when 'paciente_potencial' then 14 when 'documentacion' then 7
             when 'caso_ingresado' then 7 when 'planificacion' then 7
             when 'presentada' then 5 when 'decision' then 4
             when 'compromiso' then 7 else 7 end)
  order by extract(epoch from now() - o.stage_entered_at) desc
  limit 1;
  v_stalled_found := found;
  if v_stalled_found then
    reasons := reasons || jsonb_build_object('code', 'oportunidad_estancada',
      'text', format('Oportunidad %s hace %s días en %s (esperado: %s)',
        coalesce('“' || v_stalled.patient_name || '”', 'abierta'),
        round(v_stalled.days_in), v_stalled.stage, round(v_stalled.expected)),
      'weight', 0.8);
  end if;

  -- oportunidad caliente sin seguimiento (presentada/decision sin actividad 5 días)
  if exists (
    select 1 from opportunities o
    where o.doctor_id = p_id and o.stage in ('presentada','decision')
      and not exists (
        select 1 from activities a
        where a.doctor_id = p_id and a.occurred_at > now() - interval '5 days')
  ) then
    reasons := reasons || jsonb_build_object('code', 'seguimiento_oportunidad',
      'text', 'Caso presentado al paciente, sin seguimiento en 5 días',
      'weight', 0.75);
  end if;

  select exists(
    select 1 from tasks
    where doctor_id = p_id and status = 'pendiente'
      and due_date < current_date
  ) into v_overdue_task;
  if v_overdue_task then
    reasons := reasons || jsonb_build_object('code', 'tarea_vencida',
      'text', 'Tiene una tarea vencida', 'weight', 0.7);
  end if;

  if d.lifecycle_stage in ('activo','growth')
     and v_contact_days is not null and v_contact_days > 30 then
    reasons := reasons || jsonb_build_object('code', 'sin_contacto',
      'text', format('Sin contacto hace %s días', round(v_contact_days)),
      'weight', 0.5);
  end if;

  if jsonb_array_length(reasons) = 0 and v_potential >= 70 and v_health >= 70
     and v_capacity > coalesce(v_recent90, 0) then
    reasons := reasons || jsonb_build_object('code', 'growth',
      'text', format('Techo demostrado de %s casos/90 días, lleva %s en los últimos 90',
        v_capacity, v_recent90), 'weight', 0.4);
  end if;

  -- ---------- PRIORITY ----------
  select r->>'code', (r->>'weight')::numeric
  into top_code, top_weight
  from jsonb_array_elements(reasons) r
  order by (r->>'weight')::numeric desc
  limit 1;
  v_urgency := coalesce(top_weight, 0);

  v_value := least(1, v_open_amount / v_p90_amount);
  v_prob := coalesce(v_max_prob, 0) / 100.0;
  if exists (
    select 1 from activities
    where doctor_id = p_id and occurred_at > now() - interval '3 days'
  ) then
    v_decay := 0.5;
  end if;
  v_priority := round(100 * v_decay *
    (0.35 * v_urgency + 0.25 * v_potential / 100.0 + 0.20 * v_value + 0.20 * v_prob));
  v_priority := greatest(0, least(100, v_priority));

  v_bucket := case top_code
    when 'caso_muy_atrasado' then 'critico'
    when 'acreditado_no_activado' then 'alto_impacto'
    when 'oportunidad_estancada' then 'seguimientos'
    when 'seguimiento_oportunidad' then 'oportunidades'
    when 'tarea_vencida' then 'seguimientos'
    when 'caso_atrasado' then 'riesgo'
    when 'sin_contacto' then 'riesgo'
    when 'growth' then 'growth'
    else null end;

  v_action := case top_code
    when 'caso_muy_atrasado' then jsonb_build_object('type','llamada','label','Llamar hoy: retomar el ritmo de casos')
    when 'caso_atrasado' then jsonb_build_object('type','whatsapp','label','WhatsApp: preguntar por próximos pacientes')
    when 'acreditado_no_activado' then jsonb_build_object('type','llamada','label','Llamar: activar su primer caso')
    when 'oportunidad_estancada' then jsonb_build_object('type','whatsapp','label','WhatsApp: destrabar la oportunidad')
    when 'seguimiento_oportunidad' then jsonb_build_object('type','whatsapp','label','WhatsApp: seguimiento post-presentación')
    when 'tarea_vencida' then jsonb_build_object('type','seguimiento','label','Resolver la tarea vencida')
    when 'sin_contacto' then jsonb_build_object('type','whatsapp','label','WhatsApp: retomar contacto')
    when 'growth' then jsonb_build_object('type','visita','label','Visita: proponerle crecer en volumen')
    else null end;

  -- ---------- escribir cache ----------
  update doctors set
    health_score = v_health,
    health_factors = jsonb_build_object(
      'frequency', jsonb_build_object('points', round(h_freq,1), 'overdue_ratio', round(coalesce(v_overdue,0),2), 'interval', round(coalesce(v_interval,0)), 'basis', v_confidence),
      'contact', jsonb_build_object('points', round(h_contact,1), 'days', round(coalesce(v_contact_days,0))),
      'momentum', jsonb_build_object('points', round(h_momentum,1), 'recent90', v_recent90, 'prior90', v_prior90),
      'pipeline', jsonb_build_object('points', h_pipeline, 'open', v_open_opps),
      'negative', jsonb_build_object('points', h_neg)
    ),
    health_confidence = v_confidence,
    potential_computed = v_potential,
    priority_score = v_priority,
    priority_reasons = reasons,
    priority_bucket = v_bucket,
    recommended_action = v_action,
    avg_interval_days = v_interval,
    expected_next_case_at = case
      when v_last_new is not null and v_interval is not null
      then v_last_new + v_interval::int else null end,
    case_count = v_case_count,
    new_case_count = v_new_count,
    first_case_at = v_first,
    last_case_at = v_last,
    last_new_case_at = v_last_new,
    last_contact_at = v_last_contact
  where id = p_id;
end $fn$;

create or replace function recompute_all() returns void
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede recalcular los scores';
  end if;
  perform set_config('app.system', 'on', true);
  perform refresh_cohort_intervals();
  for r in select id from doctors loop
    perform recompute_doctor(r.id);
  end loop;
  insert into score_snapshots (doctor_id, snapshot_date, health, potential, priority)
  select id, current_date, health_score,
         coalesce(potential_override, potential_computed), priority_score
  from doctors
  on conflict (doctor_id, snapshot_date) do update
    set health = excluded.health,
        potential = excluded.potential,
        priority = excluded.priority;
end $fn$;

-- recompute liviano al vuelo cuando cambian datos del doctor
create or replace function recompute_doctor_trigger() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare v_doctor uuid;
begin
  if tg_op = 'DELETE' then
    v_doctor := old.doctor_id;
  else
    v_doctor := new.doctor_id;
  end if;
  if v_doctor is not null then
    perform recompute_doctor(v_doctor);
  end if;
  return null;
end $fn$;

create trigger cases_recompute_trg
  after insert or update on cases
  for each row execute function recompute_doctor_trigger();
create trigger activities_recompute_trg
  after insert or update or delete on activities
  for each row execute function recompute_doctor_trigger();
create trigger opportunities_recompute_trg
  after insert or update on opportunities
  for each row execute function recompute_doctor_trigger();
create trigger tasks_recompute_trg
  after insert or update on tasks
  for each row execute function recompute_doctor_trigger();

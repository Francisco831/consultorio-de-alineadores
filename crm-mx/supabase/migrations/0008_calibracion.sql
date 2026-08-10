-- 0008: calibración con Pancho (7/8/26)
-- 1. +365 días sin caso nuevo => lifecycle 'perdido', fuera de /hoy (bucket null,
--    prioridad x0.15). Un perdido/dormido con caso nuevo <=60d vuelve a 'activo'.
-- 2. El volumen histórico pesa en la prioridad (0.20 del score; 20 casos = tope).
-- 3. Doctores con <4 casos nuevos históricos: visibles pero al fondo (x0.45).
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
  v_volume numeric := 0;
  v_decay numeric := 1.0; v_priority int;
  reasons jsonb := '[]'::jsonb;
  top_code text := null; top_weight numeric := -1;
  v_bucket text; v_action jsonb;
  -- lifecycle automático (calibración 1)
  v_mark_perdido boolean := false;
  v_mark_activo boolean := false;
  v_stage_efectivo lifecycle_stage;
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

  -- ---------- lifecycle automático (calibración 1) ----------
  if v_last_new is not null
     and d.lifecycle_stage in ('activo','growth','en_riesgo','dormido') then
    if current_date - v_last_new > 365 then
      v_mark_perdido := true;
    end if;
  end if;
  if d.lifecycle_stage in ('dormido','perdido')
     and v_last_new is not null and current_date - v_last_new <= 60 then
    v_mark_activo := true;
  end if;
  v_stage_efectivo := case
    when v_mark_activo then 'activo'::lifecycle_stage
    when v_mark_perdido then 'perdido'::lifecycle_stage
    else d.lifecycle_stage end;

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
  v_lc_pts := case v_stage_efectivo
    when 'growth' then 80 when 'activo' then 60
    when 'dormido' then 30 when 'perdido' then 10
    else 50 end;
  v_potential := round(0.4 * v_cat_pts + 0.4 * v_cap_pts + 0.2 * v_lc_pts);

  -- ---------- señales de PRIORITY (con razones en español) ----------
  if v_mark_perdido or v_stage_efectivo = 'perdido' then
    -- calibración 1: los perdidos no compiten en /hoy
    reasons := reasons || jsonb_build_object('code', 'perdido_antiguo',
      'text', format('Más de un año sin casos (%s días) — marcado Perdido',
        coalesce(current_date - v_last_new, 0)), 'weight', 0.1);
  else
    if v_overdue is not null then
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

    if v_stage_efectivo in ('activo','growth')
       and v_contact_days is not null and v_contact_days > 30 then
      reasons := reasons || jsonb_build_object('code', 'sin_contacto',
        'text', format('Sin contacto hace %s días', round(v_contact_days)),
        'weight', 0.5);
    end if;

    -- calibración 2: el volumen histórico se explica (informativo, no manda)
    if v_new_count >= 10 then
      reasons := reasons || jsonb_build_object('code', 'volumen',
        'text', format('Doctor de %s casos históricos (%s)', v_new_count, d.categoria),
        'weight', 0.3);
    end if;

    if jsonb_array_length(reasons) = 0 and v_potential >= 70 and v_health >= 70
       and v_capacity > coalesce(v_recent90, 0) then
      reasons := reasons || jsonb_build_object('code', 'growth',
        'text', format('Techo demostrado de %s casos/90 días, lleva %s en los últimos 90',
          v_capacity, v_recent90), 'weight', 0.4);
    end if;
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
  -- calibración 2: volumen histórico (20 casos nuevos = tope)
  v_volume := least(1, v_new_count / 20.0);
  if exists (
    select 1 from activities
    where doctor_id = p_id and occurred_at > now() - interval '3 days'
  ) then
    v_decay := 0.5;
  end if;
  v_priority := round(100 * v_decay *
    (0.30 * v_urgency + 0.20 * v_potential / 100.0 + 0.20 * v_volume
     + 0.15 * v_value + 0.15 * v_prob));
  -- calibración 1: perdidos casi a cero
  if v_mark_perdido or v_stage_efectivo = 'perdido' then
    v_priority := round(v_priority * 0.15);
  -- calibración 3: <4 casos nuevos = visibles pero bien lejos
  elsif v_new_count > 0 and v_new_count < 4 then
    v_priority := round(v_priority * 0.45);
  end if;
  v_priority := greatest(0, least(100, v_priority));

  v_bucket := case top_code
    when 'caso_muy_atrasado' then 'critico'
    when 'acreditado_no_activado' then 'alto_impacto'
    when 'oportunidad_estancada' then 'seguimientos'
    when 'seguimiento_oportunidad' then 'oportunidades'
    when 'tarea_vencida' then 'seguimientos'
    when 'caso_atrasado' then 'riesgo'
    when 'sin_contacto' then 'riesgo'
    when 'volumen' then 'growth'
    when 'growth' then 'growth'
    else null end;  -- perdido_antiguo => null: fuera de /hoy

  v_action := case top_code
    when 'caso_muy_atrasado' then jsonb_build_object('type','llamada','label','Llamar hoy: retomar el ritmo de casos')
    when 'caso_atrasado' then jsonb_build_object('type','whatsapp','label','WhatsApp: preguntar por próximos pacientes')
    when 'acreditado_no_activado' then jsonb_build_object('type','llamada','label','Llamar: activar su primer caso')
    when 'oportunidad_estancada' then jsonb_build_object('type','whatsapp','label','WhatsApp: destrabar la oportunidad')
    when 'seguimiento_oportunidad' then jsonb_build_object('type','whatsapp','label','WhatsApp: seguimiento post-presentación')
    when 'tarea_vencida' then jsonb_build_object('type','seguimiento','label','Resolver la tarea vencida')
    when 'sin_contacto' then jsonb_build_object('type','whatsapp','label','WhatsApp: retomar contacto')
    when 'volumen' then jsonb_build_object('type','visita','label','Visita: cuidar a un doctor de alto volumen')
    when 'growth' then jsonb_build_object('type','visita','label','Visita: proponerle crecer en volumen')
    else null end;

  -- ---------- escribir cache ----------
  update doctors set
    lifecycle_stage = case
      when v_mark_activo then 'activo'::lifecycle_stage
      when v_mark_perdido then 'perdido'::lifecycle_stage
      else lifecycle_stage end,
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

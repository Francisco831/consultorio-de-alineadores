-- 0019: correcciones de la auditoría del 8/8 (post-carga del universo A).
--
-- 1. recompute_doctor BORRABA la Conversión 2 hecha a mano: si Juan marca
--    "1er caso pagado" en el kanban, el trigger escribe first_paid_case_at=hoy,
--    pero Administración carga el pago en el ledger recién después. El recompute
--    escribía first_paid_case_at = (null del ledger) y perdía la fecha.
--    Fix: coalesce — el ledger manda cuando existe, si no se respeta lo cargado.
--    (la función se re-declara entera; el resto del cuerpo es idéntico a 0016)
-- 2. campaigns sin unique(nombre): el `on conflict do nothing` del import nunca
--    disparaba y una segunda corrida duplicaba las 28 campañas.
-- 3. doctors_guard no protegía las columnas que definen el UNIVERSO del doctor
--    (is_accredited, accredited_at, activated_by, noloco_id): cualquier usuario
--    podía cruzar un doctor de universo salteando la Conversión 1 y su auditoría.
-- 4. is_system() era la única función de seguridad sin search_path fijo.

-- ---------------------------------------------------------------- 1
create or replace function recompute_doctor(p_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  d record;
  -- casos
  v_case_count int; v_new_count int;
  v_first date; v_last date; v_last_new date;
  v_interval numeric; v_confidence text;
  v_overdue numeric := null;
  -- pagos (la verdad de la activación)
  v_first_paid date; v_last_paid date; v_days_to_first int := null;
  -- contacto / engagement
  v_last_contact timestamptz;
  v_contact_days numeric := null;
  v_first_contact timestamptz; v_first_meeting timestamptz;
  v_acts30 int := 0;
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
  v_volume numeric := 0; v_engagement numeric := 0;
  v_decay numeric := 1.0; v_priority int;
  reasons jsonb := '[]'::jsonb;
  top_code text := null; top_weight numeric := -1;
  v_bucket text; v_action jsonb;
  -- lifecycle derivado
  v_new_stage lifecycle_stage;
  v_new_act_stage act_stage;
  v_reactivated date;
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
  v_new_stage := d.lifecycle_stage;
  v_new_act_stage := d.activation_stage;
  v_reactivated := d.reactivated_at;

  -- ---------- stats de casos ----------
  select count(*),
         count(*) filter (where is_new_case),
         min(fecha_ingreso)::date,
         max(fecha_ingreso)::date,
         max(fecha_ingreso) filter (where is_new_case)
  into v_case_count, v_new_count, v_first, v_last, v_last_new
  from cases where doctor_id = p_id and not is_demo;

  -- ---------- pagos ----------
  select min(paid_at), max(paid_at) into v_first_paid, v_last_paid
  from payments where doctor_id = p_id and not is_demo;
  -- days_to_first_case: el ledger de pagos arranca en 2026 — para históricos
  -- el proxy honesto de la activación es su primer caso ingresado
  if d.accredited_at is not null
     and coalesce(v_first_paid, v_first) is not null
     and coalesce(v_first_paid, v_first) >= d.accredited_at then
    v_days_to_first := coalesce(v_first_paid, v_first) - d.accredited_at;
  end if;

  -- ---------- contacto / engagement ----------
  select greatest(
    (select max(occurred_at) from activities where doctor_id = p_id),
    (select max(fecha_ingreso) from cases where doctor_id = p_id and not is_demo)
  ) into v_last_contact;
  if v_last_contact is not null then
    v_contact_days := extract(epoch from now() - v_last_contact) / 86400.0;
  end if;
  select min(occurred_at),
         min(occurred_at) filter (where type in ('reunion','visita')),
         count(*) filter (where occurred_at > now() - interval '30 days')
  into v_first_contact, v_first_meeting, v_acts30
  from activities where doctor_id = p_id;

  -- ---------- tarea vencida (aplica a ambos universos) ----------
  select exists(
    select 1 from tasks
    where doctor_id = p_id and status = 'pendiente' and due_date < current_date
  ) into v_overdue_task;

  if exists (
    select 1 from activities
    where doctor_id = p_id and occurred_at > now() - interval '3 days'
  ) then
    v_decay := 0.5;
  end if;

  -- ================================================================
  -- UNIVERSO A: NO ACREDITADO — objetivo: que se acredite
  -- ================================================================
  if not d.is_accredited then
    -- health de prospecto = temperatura del contacto (no hay casos que medir)
    if v_contact_days is not null then
      v_health := round(100 * greatest(0, least(1, 1 - (v_contact_days - 7) / 53.0)));
    else
      v_health := null;  -- nunca contactado: sin salud que medir
    end if;

    -- potential de prospecto: lo declarado/estimado, no lo demostrado
    v_potential := least(100, round(
      least(50, coalesce(d.estimated_cases_month, 0) * 10)   -- 5 casos/mes = tope
      + coalesce(d.interest_level, 2) * 5                    -- interés general
      + coalesce(d.accreditation_interest, 2) * 4            -- intención de acreditarse
      + case when d.uses_aligners then 10 else 0 end         -- ya conoce el producto
      + case when d.source in ('referido','existente','curso','universidad')
             then 8 else 0 end                               -- calidad de la fuente
    ));

    -- señales según etapa del pipeline de adquisición
    if d.lifecycle_stage = 'perdido' or d.acquisition_stage = 'no_interesado' then
      reasons := reasons || jsonb_build_object('code', 'prospecto_perdido',
        'text', 'Sin oportunidad comercial razonable hoy', 'weight', 0.05);
    else
      if d.acquisition_stage = 'interes_acreditacion' then
        reasons := reasons || jsonb_build_object('code', 'interes_acreditacion',
          'text', 'Mostró interés real en acreditarse — mandarle fechas ya',
          'weight', 0.9);
      elsif d.acquisition_stage = 'reunion_realizada' then
        reasons := reasons || jsonb_build_object('code', 'reunion_hecha',
          'text', format('Reunión realizada%s — cerrar el interés en acreditación',
            case when v_first_meeting is not null
              then format(' hace %s días', (current_date - v_first_meeting::date))
              else '' end),
          'weight', 0.85);
      elsif d.acquisition_stage = 'acreditacion_agendada' then
        reasons := reasons || jsonb_build_object('code', 'acreditacion_agendada',
          'text', format('Acreditación agendada%s — confirmar asistencia',
            case when d.accreditation_scheduled_at is not null
              then format(' (%s)', to_char(d.accreditation_scheduled_at, 'DD/MM'))
              else '' end),
          'weight', 0.7);
      elsif d.acquisition_stage = 'reunion_agendada' then
        reasons := reasons || jsonb_build_object('code', 'reunion_agendada',
          'text', 'Reunión agendada — preparar la propuesta', 'weight', 0.6);
      elsif d.acquisition_stage in ('contactado','calificado')
            and coalesce(v_contact_days, 999) > 14 then
        reasons := reasons || jsonb_build_object('code', 'prospecto_enfriandose',
          'text', case when v_contact_days is null
            then 'Prospecto contactado por WhatsApp, sin seguimiento registrado'
            else format('Prospecto contactado, sin seguimiento hace %s días',
              round(v_contact_days)) end, 'weight', 0.65);
      elsif d.acquisition_stage = 'contacto_intentado' then
        reasons := reasons || jsonb_build_object('code', 'sin_contacto_logrado',
          'text', 'Todavía no se logró contacto — reintentar por otro canal',
          'weight', 0.5);
      elsif d.acquisition_stage = 'identificado' or d.acquisition_stage is null then
        reasons := reasons || jsonb_build_object('code', 'prospecto_nuevo',
          'text', 'Prospecto identificado, todavía sin contactar', 'weight', 0.45);
      end if;

      if v_overdue_task then
        reasons := reasons || jsonb_build_object('code', 'tarea_vencida',
          'text', 'Tiene una tarea vencida', 'weight', 0.7);
      end if;
      if coalesce(d.interest_level, 0) >= 4 then
        reasons := reasons || jsonb_build_object('code', 'interes_alto',
          'text', format('Interés %s/5%s', d.interest_level,
            case when d.estimated_cases_month is not null
              then format(' · estima %s casos/mes', round(d.estimated_cases_month))
              else '' end),
          'weight', 0.55);
      end if;
    end if;

    select r->>'code', (r->>'weight')::numeric into top_code, top_weight
    from jsonb_array_elements(reasons) r
    order by (r->>'weight')::numeric desc limit 1;
    v_urgency := coalesce(top_weight, 0);
    v_engagement := least(1, v_acts30 / 4.0);

    v_priority := round(100 * v_decay *
      (0.45 * v_urgency + 0.35 * v_potential / 100.0 + 0.20 * v_engagement));
    if d.lifecycle_stage = 'perdido' or d.acquisition_stage = 'no_interesado' then
      v_priority := round(v_priority * 0.1);
      v_bucket := null;   -- fuera de /hoy
    else
      v_bucket := 'nuevo_negocio';
    end if;
    v_priority := greatest(0, least(100, v_priority));

    v_action := case top_code
      when 'interes_acreditacion' then jsonb_build_object('type','whatsapp','label','Mandar fechas de acreditación')
      when 'reunion_hecha' then jsonb_build_object('type','llamada','label','Llamar: proponer acreditación')
      when 'acreditacion_agendada' then jsonb_build_object('type','whatsapp','label','Confirmar asistencia a la acreditación')
      when 'reunion_agendada' then jsonb_build_object('type','reunion','label','Preparar la reunión')
      when 'prospecto_enfriandose' then jsonb_build_object('type','whatsapp','label','WhatsApp: retomar la conversación')
      when 'sin_contacto_logrado' then jsonb_build_object('type','llamada','label','Reintentar contacto por otro canal')
      when 'prospecto_nuevo' then jsonb_build_object('type','whatsapp','label','Hacer el primer contacto')
      when 'interes_alto' then jsonb_build_object('type','llamada','label','Avanzar hacia la acreditación')
      when 'tarea_vencida' then jsonb_build_object('type','seguimiento','label','Resolver la tarea vencida')
      else null end;

    update doctors set
      health_score = v_health,
      health_factors = jsonb_build_object(
        'contact', jsonb_build_object('days', round(coalesce(v_contact_days, -1))),
        'engagement', jsonb_build_object('acts30', v_acts30),
        'declared', jsonb_build_object(
          'interest', d.interest_level, 'accreditation_interest', d.accreditation_interest,
          'estimated_cases_month', d.estimated_cases_month)
      ),
      health_confidence = 'insuficiente',
      potential_computed = v_potential,
      priority_score = v_priority,
      priority_reasons = reasons,
      priority_bucket = v_bucket,
      recommended_action = v_action,
      avg_interval_days = null,
      expected_next_case_at = null,
      case_count = v_case_count,
      new_case_count = v_new_count,
      first_case_at = v_first,
      last_case_at = v_last,
      last_new_case_at = v_last_new,
      last_contact_at = v_last_contact,
      first_contact_at = coalesce(first_contact_at, v_first_contact),
      first_meeting_at = coalesce(first_meeting_at, v_first_meeting)
    where id = p_id;
    return;
  end if;

  -- ================================================================
  -- UNIVERSO B: ACREDITADO — objetivo: generar casos y subir frecuencia
  -- ================================================================

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

  -- ---------- lifecycle derivado (el journey completo) ----------
  -- acreditado sin primer caso → en activación
  if v_new_count = 0 and v_first_paid is null
     and d.lifecycle_stage in ('prospecto','contactado','calificacion',
       'interes_acreditacion','acreditacion_agendada','acreditado') then
    v_new_stage := 'en_activacion';
    v_new_act_stage := coalesce(v_new_act_stage, 'acreditado');
  end if;
  -- primer caso (pagado o ingresado) → activado
  if (v_first_paid is not null or v_new_count >= 1)
     and d.lifecycle_stage in ('prospecto','contactado','calificacion',
       'interes_acreditacion','acreditacion_agendada','acreditado','en_activacion') then
    v_new_stage := 'activado';
    if v_new_act_stage is not null then
      v_new_act_stage := 'primer_caso_pagado';
    end if;
  end if;
  -- repite (2+ casos nuevos) → activo
  if v_new_count >= 2 and v_new_stage = 'activado' then
    v_new_stage := 'activo';
  end if;
  -- cae vs su propio ritmo → en riesgo (y vuelve si se recupera)
  if v_new_stage in ('activo','growth') and coalesce(v_overdue, 0) >= 1.25
     and coalesce(v_overdue, 0) < 2.0 then
    v_new_stage := 'en_riesgo';
  elsif d.lifecycle_stage = 'en_riesgo' and coalesce(v_overdue, 99) < 1.0 then
    v_new_stage := 'activo';
  end if;
  -- dormido/perdido con caso reciente → REACTIVADO (con fecha)
  if d.lifecycle_stage in ('dormido','perdido')
     and v_last_new is not null and current_date - v_last_new <= 60 then
    v_new_stage := 'reactivado';
    v_reactivated := coalesce(v_reactivated, v_last_new);
  end if;
  -- reactivado que sostiene el ritmo 90 días → activo pleno
  if d.lifecycle_stage = 'reactivado' then
    if d.reactivated_at is not null and d.reactivated_at < current_date - 90
       and coalesce(v_overdue, 0) < 1.25 then
      v_new_stage := 'activo';
    elsif v_last_new is not null and current_date - v_last_new > 365 then
      v_new_stage := 'perdido';
    end if;
  end if;
  -- más de un año sin caso → perdido (calibración 7/8)
  if v_last_new is not null
     and d.lifecycle_stage in ('activo','growth','en_riesgo','dormido','activado')
     and current_date - v_last_new > 365 then
    v_new_stage := 'perdido';
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
           when 'viabilidad' then 1
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
  v_lc_pts := case v_new_stage
    when 'growth' then 80 when 'activo' then 60 when 'reactivado' then 60
    when 'dormido' then 30 when 'perdido' then 10
    else 50 end;
  v_potential := round(0.4 * v_cat_pts + 0.4 * v_cap_pts + 0.2 * v_lc_pts);

  -- ---------- señales de PRIORITY ----------
  if v_new_stage = 'perdido' then
    reasons := reasons || jsonb_build_object('code', 'perdido_antiguo',
      'text', format('Más de un año sin casos (%s días) — marcado Perdido',
        coalesce(current_date - v_last_new, 0)), 'weight', 0.1);
  else
    if v_overdue is not null and v_new_stage <> 'en_activacion' then
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

    -- CONVERSIÓN 2 pendiente: acreditado sin primer caso
    if v_new_stage = 'en_activacion'
       and coalesce(d.accredited_at, d.created_at::date) < current_date - 30 then
      reasons := reasons || jsonb_build_object('code', 'acreditado_no_activado',
        'text', format('Acreditado hace %s días y nunca mandó un caso',
          current_date - coalesce(d.accredited_at, d.created_at::date)), 'weight', 0.9);
    elsif v_new_stage = 'en_activacion' then
      reasons := reasons || jsonb_build_object('code', 'activacion_fresca',
        'text', format('Acreditado hace %s días — buscar su primer paciente YA',
          current_date - coalesce(d.accredited_at, d.created_at::date)), 'weight', 0.8);
    end if;

    -- CONVERSIÓN 3 pendiente: activado que no repite
    if v_new_stage = 'activado' and coalesce(v_overdue, 0) < 1.25 then
      reasons := reasons || jsonb_build_object('code', 'primer_caso_sin_repetir',
        'text', format('Mandó su primer caso%s — ir por el segundo',
          case when v_last_new is not null
            then format(' hace %s días', current_date - v_last_new) else '' end),
        'weight', 0.75);
    end if;

    -- reactivado reciente: sostener el impulso
    if v_new_stage = 'reactivado' then
      reasons := reasons || jsonb_build_object('code', 'reactivado_reciente',
        'text', format('Se reactivó%s después de estar dormido — sostener el impulso',
          case when v_reactivated is not null
            then format(' hace %s días', current_date - v_reactivated) else '' end),
        'weight', 0.65);
    end if;

    -- oportunidad estancada
    select coalesce(params->'expected_days', '{}'::jsonb) into v_expected_days
    from automation_rules where key = 'oportunidad_estancada';
    select o.patient_name, o.stage,
           extract(epoch from now() - o.stage_entered_at) / 86400.0 as days_in,
           coalesce((v_expected_days->>o.stage::text)::numeric,
             case o.stage
               when 'viabilidad' then 10
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
               when 'viabilidad' then 10
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

    if v_overdue_task then
      reasons := reasons || jsonb_build_object('code', 'tarea_vencida',
        'text', 'Tiene una tarea vencida', 'weight', 0.7);
    end if;

    if v_new_stage in ('activo','growth','reactivado')
       and v_contact_days is not null and v_contact_days > 30 then
      reasons := reasons || jsonb_build_object('code', 'sin_contacto',
        'text', format('Sin contacto hace %s días', round(v_contact_days)),
        'weight', 0.5);
    end if;

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
  v_volume := least(1, v_new_count / 20.0);
  v_priority := round(100 * v_decay *
    (0.30 * v_urgency + 0.20 * v_potential / 100.0 + 0.20 * v_volume
     + 0.15 * v_value + 0.15 * v_prob));
  if v_new_stage = 'perdido' then
    v_priority := round(v_priority * 0.15);
  elsif v_new_stage in ('en_activacion','activado','reactivado') then
    null;  -- las conversiones 2 y 3 no se castigan por bajo volumen histórico
  elsif v_new_count > 0 and v_new_count < 4 then
    v_priority := round(v_priority * 0.45);
  end if;
  v_priority := greatest(0, least(100, v_priority));

  v_bucket := case top_code
    when 'caso_muy_atrasado' then 'critico'
    when 'acreditado_no_activado' then 'activacion'
    when 'activacion_fresca' then 'activacion'
    when 'primer_caso_sin_repetir' then 'activacion'
    when 'reactivado_reciente' then 'growth'
    when 'oportunidad_estancada' then 'seguimientos'
    when 'seguimiento_oportunidad' then 'oportunidades'
    when 'tarea_vencida' then 'seguimientos'
    when 'caso_atrasado' then 'riesgo'
    when 'sin_contacto' then 'riesgo'
    when 'volumen' then 'growth'
    when 'growth' then 'growth'
    else null end;

  v_action := case top_code
    when 'caso_muy_atrasado' then jsonb_build_object('type','llamada','label','Llamar hoy: retomar el ritmo de casos')
    when 'caso_atrasado' then jsonb_build_object('type','whatsapp','label','WhatsApp: preguntar por próximos pacientes')
    when 'acreditado_no_activado' then jsonb_build_object('type','llamada','label','Llamar: activar su primer caso')
    when 'activacion_fresca' then jsonb_build_object('type','whatsapp','label','WhatsApp: pedir su primer paciente potencial')
    when 'primer_caso_sin_repetir' then jsonb_build_object('type','whatsapp','label','WhatsApp: buscar el segundo caso')
    when 'reactivado_reciente' then jsonb_build_object('type','llamada','label','Llamar: sostener la reactivación')
    when 'oportunidad_estancada' then jsonb_build_object('type','whatsapp','label','WhatsApp: destrabar la oportunidad')
    when 'seguimiento_oportunidad' then jsonb_build_object('type','whatsapp','label','WhatsApp: seguimiento post-presentación')
    when 'tarea_vencida' then jsonb_build_object('type','seguimiento','label','Resolver la tarea vencida')
    when 'sin_contacto' then jsonb_build_object('type','whatsapp','label','WhatsApp: retomar contacto')
    when 'volumen' then jsonb_build_object('type','visita','label','Visita: cuidar a un doctor de alto volumen')
    when 'growth' then jsonb_build_object('type','visita','label','Visita: proponerle crecer en volumen')
    else null end;

  -- ---------- escribir cache ----------
  update doctors set
    lifecycle_stage = v_new_stage,
    activation_stage = v_new_act_stage,
    reactivated_at = v_reactivated,
    -- el ledger manda cuando tiene la fila; si el pago todavía no se cargó,
    -- NO se pisa la fecha que dejó la Conversión 2 hecha a mano en el kanban
    first_paid_case_at = coalesce(v_first_paid, first_paid_case_at),
    last_paid_case_at = coalesce(v_last_paid, last_paid_case_at),
    days_to_first_case = coalesce(v_days_to_first, days_to_first_case),
    first_contact_at = coalesce(first_contact_at, v_first_contact),
    first_meeting_at = coalesce(first_meeting_at, v_first_meeting),
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

-- ---------------------------------------------------------------- 2
-- dedupe defensivo antes de crear la constraint
with dupes as (
  select nombre, min(ctid::text) as keep
  from campaigns
  group by nombre
  having count(*) > 1
)
delete from campaigns c
using dupes d
where c.nombre = d.nombre and c.ctid::text <> d.keep;

create unique index if not exists campaigns_nombre_key on campaigns (nombre);

-- ---------------------------------------------------------------- 3
-- El corte entre universos es de negocio, no cosmético: sale del trigger de
-- journey (Conversión 1) o del import. Un usuario no lo escribe a mano.
create or replace function doctors_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.health_score := null;          new.health_factors := null;
    new.health_confidence := null;     new.potential_computed := null;
    new.priority_score := null;        new.priority_reasons := null;
    new.priority_bucket := null;       new.recommended_action := null;
    new.avg_interval_days := null;     new.expected_next_case_at := null;
    new.case_count := 0;               new.new_case_count := 0;
    new.first_case_at := null;         new.last_case_at := null;
    new.last_new_case_at := null;
    new.first_paid_case_at := null;    new.last_paid_case_at := null;
    new.days_to_first_case := null;
    -- un alta desde la app siempre nace como prospecto del universo A
    new.is_accredited := false;        new.accredited_at := null;
    new.activated_by := null;          new.noloco_id := null;
    if not is_manager() then
      new.potential_override := null;
    end if;
    return new;
  end if;
  if new.health_score          is distinct from old.health_score
  or new.health_factors        is distinct from old.health_factors
  or new.health_confidence     is distinct from old.health_confidence
  or new.potential_computed    is distinct from old.potential_computed
  or new.priority_score        is distinct from old.priority_score
  or new.priority_reasons      is distinct from old.priority_reasons
  or new.priority_bucket       is distinct from old.priority_bucket
  or new.recommended_action    is distinct from old.recommended_action
  or new.avg_interval_days     is distinct from old.avg_interval_days
  or new.expected_next_case_at is distinct from old.expected_next_case_at
  or new.case_count            is distinct from old.case_count
  or new.new_case_count        is distinct from old.new_case_count
  or new.first_case_at         is distinct from old.first_case_at
  or new.last_case_at          is distinct from old.last_case_at
  or new.last_new_case_at      is distinct from old.last_new_case_at
  or new.first_paid_case_at    is distinct from old.first_paid_case_at
  or new.last_paid_case_at     is distinct from old.last_paid_case_at
  or new.days_to_first_case    is distinct from old.days_to_first_case
  or new.first_contact_at      is distinct from old.first_contact_at
  or new.first_meeting_at      is distinct from old.first_meeting_at
  then
    raise exception 'Las columnas de score las calcula el sistema';
  end if;
  -- ---- el UNIVERSO del doctor: lo mueve el trigger de journey, no el usuario ----
  if new.is_accredited is distinct from old.is_accredited
  or new.accredited_at is distinct from old.accredited_at
  or new.activated_by is distinct from old.activated_by
  or new.noloco_id    is distinct from old.noloco_id
  then
    raise exception 'La acreditación se registra moviendo al doctor a "Acreditado" en el pipeline, no editando el campo';
  end if;
  if not is_manager() then
    if new.owner_id           is distinct from old.owner_id
    or new.clinical_owner_id  is distinct from old.clinical_owner_id
    or new.categoria          is distinct from old.categoria
    or new.potential_override is distinct from old.potential_override
    then
      raise exception 'Solo un manager puede cambiar owner, categoría o potential override';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- 4
create or replace function is_system() returns boolean
language sql stable set search_path = public as $$
  select auth.uid() is null or coalesce(current_setting('app.system', true), '') = 'on'
$$;

-- 0020: la automatización de prospectos generó 4.945 tareas (una por cada
-- contacto histórico de la planilla madre). Eso entierra al vendedor y rompe
-- el principio del CRM: decir QUÉ HACER HOY, no dar una lista infinita.
--
-- Regla nueva: solo prospectos que valen una llamada (interés declarado,
-- volumen estimado, o ya avanzados en el pipeline) y con TOPE por corrida.
-- Los demás siguen visibles y priorizados en /prospeccion y /hoy — no se
-- pierden, simplemente no generan tarea.

update automation_rules
set params = '{"days": 14, "max_per_run": 25, "min_interest": 3, "min_casos_mes": 2}'::jsonb,
    descripcion = 'Prospecto calificado (interés 3+, 2+ casos/mes estimados, o con reunión) sin contacto en 14 días. Crea hasta 25 tareas por corrida, las más prioritarias primero.'
where key = 'prospecto_sin_seguimiento';

-- limpieza de la avalancha: son tareas generadas por la automatización, nunca
-- tocadas por una persona (sin outcome, pendientes). Las creadas a mano y las
-- de otras reglas NO se tocan.
delete from tasks t
using automation_rules r
where t.automation_rule_id = r.id
  and r.key = 'prospecto_sin_seguimiento'
  and t.status = 'pendiente'
  and t.outcome is null;

-- evaluador con la rama acotada
create or replace function evaluate_automations() returns void
language plpgsql security definer set search_path = public as $fn$
declare
  rule record;
  v_count int;
  stats jsonb := '{}'::jsonb;
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede ejecutar las automatizaciones';
  end if;
  perform set_config('app.system', 'on', true);
  perform set_config('app.source', 'automation', true);

  for rule in select * from automation_rules where enabled loop
    v_count := 0;

    -- ================================================================
    if rule.key = 'caso_atrasado' then
      with candidates as (
        select d.* from doctors d
        where d.lifecycle_stage in ('activo','growth','reactivado')
          and d.health_confidence in ('personal','cohort')
          and d.avg_interval_days is not null and d.last_new_case_at is not null
          and (current_date - d.last_new_case_at) / d.avg_interval_days
              > coalesce((rule.params->>'threshold')::numeric, 1.25)
      ), ins_alerts as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, c.id, 'alta',
          format('%s está atrasado con su próximo caso', c.nombre),
          format('Lleva %s días sin caso nuevo; su ritmo es cada %s días.',
            current_date - c.last_new_case_at, round(c.avg_interval_days)),
          c.is_demo
        from candidates c
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = c.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins_alerts;

      insert into tasks (doctor_id, type, title, due_date, assigned_to, created_by,
                         automation_rule_id, is_demo)
      select c.id, coalesce(rule.task_type, 'llamada'),
        format('Llamar a %s: retomar ritmo de casos', c.nombre),
        current_date, c.owner_id, null, rule.id, c.is_demo
      from doctors c
      where rule.creates_task
        and c.lifecycle_stage in ('activo','growth','reactivado')
        and c.health_confidence in ('personal','cohort')
        and c.avg_interval_days is not null and c.last_new_case_at is not null
        and (current_date - c.last_new_case_at) / c.avg_interval_days
            > coalesce((rule.params->>'threshold')::numeric, 1.25)
        and not exists (select 1 from tasks t
          where t.doctor_id = c.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id);

    -- ================================================================
    elsif rule.key = 'sin_contacto' then
      insert into tasks (doctor_id, type, title, due_date, assigned_to,
                         automation_rule_id, is_demo)
      select d.id, coalesce(rule.task_type, 'whatsapp'),
        format('WhatsApp a %s: retomar contacto', d.nombre),
        current_date, d.owner_id, rule.id, d.is_demo
      from doctors d
      where d.lifecycle_stage in ('activo','growth','activado','reactivado')
        and d.last_contact_at < now() -
          (coalesce((rule.params->>'days')::int, 30) || ' days')::interval
        and not exists (select 1 from tasks t
          where t.doctor_id = d.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id);
      get diagnostics v_count = row_count;

    -- ================================================================
    elsif rule.key = 'oportunidad_estancada' then
      with expected as (
        select coalesce(rule.params->'expected_days', '{}'::jsonb) as ed
      ), stalled as (
        select o.*, d.nombre as doctor_nombre,
          extract(epoch from now() - o.stage_entered_at) / 86400.0 as days_in,
          coalesce(((select ed from expected)->>o.stage::text)::numeric,
            case o.stage
              when 'viabilidad' then 10
              when 'paciente_potencial' then 14 when 'documentacion' then 7
              when 'caso_ingresado' then 7 when 'planificacion' then 7
              when 'presentada' then 5 when 'decision' then 4
              when 'compromiso' then 7 else 7 end) as expected_days
        from opportunities o join doctors d on d.id = o.doctor_id
        where o.stage not in ('ganada','perdida')
      ), ins as (
        insert into alerts (rule_key, doctor_id, opportunity_id, severity, title, reason, is_demo)
        select rule.key, s.doctor_id, s.id, 'media',
          format('Oportunidad estancada: %s', coalesce(s.patient_name, s.doctor_nombre)),
          format('Lleva %s días en %s; lo esperado son %s días.',
            round(s.days_in), s.stage, round(s.expected_days)),
          s.is_demo
        from stalled s
        where s.days_in > coalesce((rule.params->>'multiplier')::numeric, 1.5) * s.expected_days
          and not exists (select 1 from alerts a
            where a.rule_key = rule.key and a.opportunity_id = s.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'acreditado_no_activado' then
      update doctors d set lifecycle_stage = 'en_activacion',
        activation_stage = coalesce(activation_stage, 'acreditado')
      where d.lifecycle_stage = 'acreditado' and d.new_case_count = 0
        and coalesce(d.accredited_at, d.created_at::date)
            < current_date - coalesce((rule.params->>'days')::int, 30);

      with candidates as (
        select d.* from doctors d
        where d.lifecycle_stage = 'en_activacion'
          and d.new_case_count = 0
          and coalesce(d.accredited_at, d.created_at::date)
              < current_date - coalesce((rule.params->>'days')::int, 30)
      ), ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, c.id, 'alta',
          format('%s: acreditado sin activar', c.nombre),
          format('Acreditado hace %s días y todavía no mandó su primer caso.',
            current_date - coalesce(c.accredited_at, c.created_at::date)),
          c.is_demo
        from candidates c
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = c.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

      insert into tasks (doctor_id, type, title, due_date, assigned_to,
                         automation_rule_id, is_demo)
      select c.id, coalesce(rule.task_type, 'llamada'),
        format('Llamar a %s: activar su primer caso', c.nombre),
        current_date, c.owner_id, rule.id, c.is_demo
      from doctors c
      where rule.creates_task
        and c.lifecycle_stage = 'en_activacion'
        and c.new_case_count = 0
        and coalesce(c.accredited_at, c.created_at::date)
            < current_date - coalesce((rule.params->>'days')::int, 30)
        and not exists (select 1 from tasks t
          where t.doctor_id = c.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id);

    -- ================================================================
    elsif rule.key = 'dormido_detectado' then
      with moved as (
        update doctors d set lifecycle_stage = 'dormido'
        where d.lifecycle_stage in ('activo','growth','en_riesgo','activado','reactivado')
          and d.avg_interval_days is not null and d.last_new_case_at is not null
          and (current_date - d.last_new_case_at) / d.avg_interval_days
              > coalesce((rule.params->>'threshold')::numeric, 2.0)
        returning d.*
      ), ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, m.id, 'critica',
          format('%s se durmió', m.nombre),
          format('Superó el doble de su ritmo: %s días sin caso nuevo (ritmo: cada %s).',
            current_date - m.last_new_case_at, round(m.avg_interval_days)),
          m.is_demo
        from moved m
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = m.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'reactivacion' then
      with moved as (
        update doctors d set lifecycle_stage = 'reactivado',
          reactivated_at = coalesce(d.reactivated_at, d.last_new_case_at, current_date)
        where d.lifecycle_stage in ('dormido','en_riesgo','perdido')
          and d.last_new_case_at > current_date - 7
        returning d.*
      ), closed as (
        update alerts a set status = 'resuelta', resolved_at = now()
        where a.doctor_id in (select id from moved)
          and a.rule_key in ('dormido_detectado','caso_atrasado')
          and a.status = 'abierta'
      ), ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, m.id, 'info',
          format('🎉 %s se reactivó', m.nombre),
          'Volvió a mandar un caso después de estar dormido.',
          m.is_demo
        from moved m
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = m.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'tarea_vencida' then
      with ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select distinct on (t.doctor_id)
          rule.key, t.doctor_id, 'media',
          format('Tarea vencida: %s', t.title),
          format('Vencida hace %s días. Asignada a %s.',
            current_date - t.due_date,
            coalesce((select nombre from profiles p where p.id = t.assigned_to), 'nadie')),
          t.is_demo
        from tasks t
        where t.status = 'pendiente' and t.doctor_id is not null
          and t.due_date < current_date - coalesce((rule.params->>'days')::int, 3)
          and not exists (select 1 from alerts a
            where a.rule_key = rule.key and a.doctor_id = t.doctor_id and a.status = 'abierta')
        order by t.doctor_id, t.due_date
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'aprobacion_pendiente' then
      with ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select distinct on (c.doctor_id)
          rule.key, c.doctor_id, 'media',
          format('Video sin aprobar: caso %s', coalesce(c.id_externo, c.noloco_case_id)),
          format('El video está listo hace %s días y %s no lo aprobó (paciente %s).',
            extract(day from now() - c.fecha_video)::int, d.nombre, coalesce(c.paciente, '—')),
          c.is_demo
        from cases c join doctors d on d.id = c.doctor_id
        where c.fecha_video is not null and c.fecha_aprobacion_video is null
          and c.fecha_video < now() - (coalesce((rule.params->>'days')::int, 7) || ' days')::interval
          and c.fecha_video >= coalesce((rule.params->>'cutoff')::timestamptz, '2026-06-01'::timestamptz)
          and not exists (select 1 from alerts a
            where a.rule_key = rule.key and a.doctor_id = c.doctor_id and a.status = 'abierta')
        order by c.doctor_id, c.fecha_video
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'prospecto_sin_seguimiento' then
      -- ACOTADA (0020): solo prospectos que valen la llamada y con tope por
      -- corrida. Con 5.000 contactados históricos, sin esto se genera una
      -- tarea por cada uno y la bandeja del vendedor deja de servir.
      insert into tasks (doctor_id, type, title, due_date, assigned_to,
                         automation_rule_id, is_demo)
      select d.id, coalesce(rule.task_type, 'whatsapp'),
        format('Seguimiento a %s: avanzar hacia la acreditación', d.nombre),
        current_date, d.owner_id, rule.id, d.is_demo
      from doctors d
      where not d.is_accredited
        and d.acquisition_stage in ('contactado','calificado','reunion_agendada',
                                    'reunion_realizada','interes_acreditacion')
        and (d.last_contact_at is null or d.last_contact_at < now() -
          (coalesce((rule.params->>'days')::int, 14) || ' days')::interval)
        -- calificado: interés declarado, volumen estimado o ya tuvo reunión
        and (
          coalesce(d.interest_level, 0) >= coalesce((rule.params->>'min_interest')::int, 3)
          or coalesce(d.estimated_cases_month, 0) >= coalesce((rule.params->>'min_casos_mes')::numeric, 2)
          or d.acquisition_stage in ('reunion_agendada','reunion_realizada','interes_acreditacion')
        )
        and not exists (select 1 from tasks t
          where t.doctor_id = d.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id)
      order by d.priority_score desc nulls last
      limit coalesce((rule.params->>'max_per_run')::int, 25);
      get diagnostics v_count = row_count;
    end if;

    update automation_rules set last_run_at = now(),
      run_stats = jsonb_build_object('last_created', v_count)
      where id = rule.id;
    stats := stats || jsonb_build_object(rule.key, v_count);
  end loop;
end $fn$;

-- 0043 — Seguimiento de renders (videos) y de viabilidades.
--
-- Pedido de Pancho (26/8): "que aparezca un listado de videos pendientes de
-- aprobar y salgan alarmas si hay una semana sin aprobación o rechazo" y, sobre
-- la marcha, "además del seguimiento del render y su publicación, también hay
-- que hacer seguimiento de las viabilidades".
--
-- QUÉ HABÍA. El dato de video ya está: `cases.fecha_video` /
-- `cases.fecha_aprobacion_video`, que llena el sync de Noloco cada 2 horas, con
-- índice propio desde 0002. La regla `aprobacion_pendiente` existe desde 0006 y
-- corre cada hora por pg_cron. Pero tenía tres problemas:
--   1. `distinct on (c.doctor_id)`: una sola alerta por doctora, con el título de
--      UN caso. Nunca se supo que la Dra. X tiene 4 videos parados, no uno.
--   2. Un `cutoff` fijo del 1/6/2026, puesto para tapar el ruido de casos viejos
--      que en realidad ya avanzaron y quedaron con la fecha sin cerrar.
--   3. Severidad fija 'media' aunque el video lleve dos meses.
-- Medición del 26/8 contra producción: 98 casos con video sin aprobar, 93 con
-- más de 7 días. El corte de "sin fecha de finalizado" saca los que ya avanzaron.
--
-- LO QUE FALTABA: viabilidades. El esquema del ciclo existe desde 0022
-- (`opportunities.viability_status/result/requested_at/...`) y la etapa
-- `viabilidad` desde 0010, pero nadie lo registra: hoy hay 2 oportunidades en esa
-- etapa, las dos sin ciclo cargado, esperando hace 27 y 36 días. La regla nueva
-- avisa; la pantalla /seguimiento las lista y deja registrar la respuesta.
--
-- Rollback: supabase/rollbacks/0043_seguimiento_render_viabilidad_rollback.sql

-- ---------------------------------------------------------------------------
-- Regla nueva: viabilidad sin respuesta
-- ---------------------------------------------------------------------------
insert into automation_rules (key, nombre, descripcion, params, creates_task, task_type, enabled)
values (
  'viabilidad_sin_respuesta',
  'Viabilidad sin respuesta',
  'Viabilidad pedida al equipo clínico hace 7+ días sin respuesta registrada. Alerta, sin tarea (el cupo de 0042 es para el trabajo comercial).',
  '{"days": 7, "days_critico": 14}'::jsonb,
  false, null, true
)
on conflict (key) do update
  set descripcion = excluded.descripcion,
      params      = excluded.params,
      enabled     = true;

-- El corte de 7 días de la regla de video pasa a ser el único parámetro: el
-- cutoff se va, y en su lugar entra el filtro por casos todavía vivos.
update automation_rules
   set params = '{"days": 7, "days_critico": 14}'::jsonb,
       descripcion = 'Render/video listo hace 7+ días sin aprobación ni rechazo del doctor. Una alerta por doctora, con cuántos casos y el más viejo. Crítica a los 14 días.'
 where key = 'aprobacion_pendiente';

-- ---------------------------------------------------------------------------
-- evaluate_automations() — se reescribe entera (create or replace no admite
-- parches parciales). Respecto de 0020 cambian SOLO dos ramas y se agrega una:
--   · aprobacion_pendiente: agregada por doctora, sin cutoff, con severidad
--   · viabilidad_sin_respuesta: nueva
--   · prospecto_sin_seguimiento / sin_contacto / caso_atrasado /
--     acreditado_no_activado / oportunidad_estancada / dormido_detectado /
--     reactivacion / tarea_vencida: idénticas a 0020. El cupo de tareas ya no
--     vive acá sino en el trigger de 0042.
-- ---------------------------------------------------------------------------
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
    -- 0043: una alerta POR DOCTORA con TODOS sus renders parados, no una por
    -- caso suelto. Sin cutoff: lo que sacaba el ruido de casos viejos no era la
    -- fecha sino que el caso ya hubiera avanzado (fecha_finalizado).
    elsif rule.key = 'aprobacion_pendiente' then
      with parados as (
        select c.doctor_id, d.nombre, d.is_demo,
               count(*) as n,
               min(c.fecha_video) as mas_viejo,
               (array_agg(coalesce(c.id_externo, c.noloco_case_id) order by c.fecha_video))[1] as caso_viejo
        from cases c join doctors d on d.id = c.doctor_id
        where c.fecha_video is not null
          and c.fecha_aprobacion_video is null
          and c.fecha_finalizado is null
          and c.fecha_video < now() - (coalesce((rule.params->>'days')::int, 7) || ' days')::interval
        group by c.doctor_id, d.nombre, d.is_demo
      ), ins as (
        insert into alerts (rule_key, doctor_id, severity, title, reason, is_demo)
        select rule.key, p.doctor_id,
          case when p.mas_viejo < now() - (coalesce((rule.params->>'days_critico')::int, 14) || ' days')::interval
               then 'alta' else 'media' end,
          case when p.n = 1
               then format('%s tiene un render sin aprobar', p.nombre)
               else format('%s tiene %s renders sin aprobar', p.nombre, p.n) end,
          format('El más viejo es %s, listo hace %s días, sin aprobación ni rechazo.',
            coalesce(p.caso_viejo, '—'), extract(day from now() - p.mas_viejo)::int),
          p.is_demo
        from parados p
        where not exists (select 1 from alerts a
          where a.rule_key = rule.key and a.doctor_id = p.doctor_id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    -- 0043: viabilidades pedidas al equipo clínico que no volvieron.
    -- Cuentan las dos formas en que hoy queda registrada una viabilidad:
    -- el ciclo explícito (viability_status) y la etapa 'viabilidad' del pipeline.
    elsif rule.key = 'viabilidad_sin_respuesta' then
      with esperando as (
        select o.id, o.doctor_id, o.patient_name, o.is_demo, d.nombre as doctor_nombre,
          coalesce(o.viability_submitted_at, o.viability_requested_at, o.stage_entered_at) as desde
        from opportunities o join doctors d on d.id = o.doctor_id
        where o.stage not in ('ganada','perdida')
          and o.viability_completed_at is null
          and (o.viability_status in ('solicitada','enviada') or o.stage = 'viabilidad')
      ), ins as (
        insert into alerts (rule_key, doctor_id, opportunity_id, severity, title, reason, is_demo)
        select rule.key, e.doctor_id, e.id,
          case when e.desde < now() - (coalesce((rule.params->>'days_critico')::int, 14) || ' days')::interval
               then 'alta' else 'media' end,
          format('Viabilidad sin respuesta: %s', coalesce(e.patient_name, e.doctor_nombre)),
          format('Pedida hace %s días y el equipo clínico todavía no respondió.',
            extract(day from now() - e.desde)::int),
          e.is_demo
        from esperando e
        where e.desde < now() - (coalesce((rule.params->>'days')::int, 7) || ' days')::interval
          and not exists (select 1 from alerts a
            where a.rule_key = rule.key and a.opportunity_id = e.id and a.status = 'abierta')
        returning 1
      )
      select count(*) into v_count from ins;

    -- ================================================================
    elsif rule.key = 'prospecto_sin_seguimiento' then
      -- ACOTADA (0020) + cupo por persona (0042, en el trigger de tasks).
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
        and (
          coalesce(d.interest_level, 0) >= coalesce((rule.params->>'min_interest')::int, 3)
          or coalesce(d.estimated_cases_month, 0) >= coalesce((rule.params->>'min_casos_mes')::numeric, 2)
          or d.acquisition_stage in ('reunion_agendada','reunion_realizada','interes_acreditacion')
        )
        and not exists (select 1 from tasks t
          where t.doctor_id = d.id and t.status = 'pendiente'
            and t.automation_rule_id = rule.id)
      order by d.priority_score desc nulls last
      limit coalesce((rule.params->>'max_per_run')::int, 5);
      get diagnostics v_count = row_count;
    end if;

    update automation_rules set last_run_at = now(),
      run_stats = jsonb_build_object('last_created', v_count)
      where id = rule.id;
    stats := stats || jsonb_build_object(rule.key, v_count);
  end loop;
end $fn$;

revoke all on function evaluate_automations() from public, anon;
grant execute on function evaluate_automations() to authenticated, service_role;

-- las alertas viejas de video con el título de un caso suelto ya no describen
-- lo que la regla nueva quiere decir: se cierran para que se regeneren agregadas
update alerts set status = 'resuelta', resolved_at = now()
 where rule_key = 'aprobacion_pendiente' and status = 'abierta';

do $$
declare v int; b int;
begin
  select count(*) into v from cases
   where fecha_video is not null and fecha_aprobacion_video is null and fecha_finalizado is null
     and fecha_video < now() - interval '7 days';
  select count(*) into b from opportunities
   where stage not in ('ganada','perdida') and viability_completed_at is null
     and (viability_status in ('solicitada','enviada') or stage = 'viabilidad');
  raise notice '0043 OK: % renders sin aprobar hace 7+ días, % viabilidades esperando respuesta.', v, b;
end $$;

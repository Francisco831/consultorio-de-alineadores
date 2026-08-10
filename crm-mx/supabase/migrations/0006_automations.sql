-- 0006: motor de automatizaciones V1 — evaluador horario + 8 reglas seed + purge_demo + cron
--
-- Diseño: una función evaluate_automations() que recorre automation_rules habilitadas.
-- Cada key es una rama hardcodeada parametrizada por params (el "no-code" V1 son los
-- umbrales editables en /ajustes). Idempotente: dedupe por NOT EXISTS de alerta abierta.

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
        where d.lifecycle_stage in ('activo','growth')
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
        and c.lifecycle_stage in ('activo','growth')
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
      where d.lifecycle_stage in ('activo','growth')
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
      -- transición: acreditado viejo sin casos pasa a "no activado"
      update doctors d set lifecycle_stage = 'acreditado_no_activado'
      where d.lifecycle_stage = 'acreditado' and d.new_case_count = 0
        and coalesce(d.accredited_at, d.created_at::date)
            < current_date - coalesce((rule.params->>'days')::int, 30);

      with candidates as (
        select d.* from doctors d
        where d.lifecycle_stage in ('acreditado_no_activado','en_activacion')
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
        and c.lifecycle_stage in ('acreditado_no_activado','en_activacion')
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
        where d.lifecycle_stage in ('activo','growth','en_riesgo')
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
        update doctors d set lifecycle_stage = 'activo'
        where d.lifecycle_stage in ('dormido','en_riesgo','perdido')
          and d.last_new_case_at > current_date - 7
        returning d.*
      ), closed as (
        -- al reactivarse, cierra la alerta de dormido
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
      -- distinct on: una sola alerta por doctor por corrida (la tarea más vencida)
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
      -- distinct on: una sola alerta por doctor por corrida (el video más viejo)
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
    end if;

    update automation_rules set last_run_at = now(),
      run_stats = jsonb_build_object('last_created', v_count)
      where id = rule.id;
    stats := stats || jsonb_build_object(rule.key, v_count);
  end loop;
end $fn$;

-- ---------- reglas seed ----------
insert into automation_rules (key, nombre, descripcion, enabled, params, creates_task, task_type) values
  ('caso_atrasado', 'Doctor atrasado con su próximo caso',
   'Activo que superó 1,25× su ritmo propio de casos. Alerta + tarea de llamada.',
   true, '{"threshold": 1.25}', true, 'llamada'),
  ('sin_contacto', 'Doctor activo sin contacto',
   'Activo sin ninguna interacción en 30 días. Crea tarea de WhatsApp al owner.',
   true, '{"days": 30}', true, 'whatsapp'),
  ('oportunidad_estancada', 'Oportunidad estancada',
   'Oportunidad que lleva más de 1,5× los días esperados en su etapa.',
   true, '{"multiplier": 1.5, "expected_days": {"paciente_potencial": 14, "documentacion": 7, "caso_ingresado": 7, "planificacion": 7, "presentada": 5, "decision": 4, "compromiso": 7}}', false, null),
  ('acreditado_no_activado', 'Acreditado sin activar',
   'Acreditado hace 30+ días sin su primer caso. Alerta + tarea de llamada.',
   true, '{"days": 30}', true, 'llamada'),
  ('dormido_detectado', 'Doctor dormido',
   'Superó 2× su ritmo propio: pasa a Dormido y alerta crítica.',
   true, '{"threshold": 2.0}', false, null),
  ('reactivacion', 'Reactivación 🎉',
   'Doctor dormido que volvió a mandar caso: pasa a Activo y cierra sus alertas.',
   true, '{}', false, null),
  ('tarea_vencida', 'Tarea vencida',
   'Tarea pendiente vencida hace 3+ días. Alerta para el manager.',
   true, '{"days": 3}', false, null),
  ('aprobacion_pendiente', 'Video sin aprobar',
   'Video de tratamiento listo hace 7+ días sin aprobación del doctor.',
   true, '{"days": 7, "cutoff": "2026-06-01"}', false, null)
on conflict (key) do nothing;

-- ---------- purga de datos demo ----------
create or replace function purge_demo() returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is not null and not is_manager() then
    raise exception 'Solo un manager puede borrar los datos demo';
  end if;
  perform set_config('app.system', 'on', true);
  delete from alerts where is_demo;
  delete from tasks where is_demo;
  delete from activities where is_demo;
  delete from payments where is_demo;
  delete from opportunities where is_demo;
  delete from cases where is_demo;
  delete from doctors where is_demo;
  perform recompute_all();
end $fn$;

-- ---------- permisos de ejecución de funciones (PostgREST expone todo por default) ----------
-- anon no ejecuta NINGUNA función del sistema; log_audit y las internas tampoco
-- las ejecuta authenticated (solo las llaman triggers/funciones definer como owner).
revoke execute on function purge_demo() from public, anon;
revoke execute on function recompute_all() from public, anon;
revoke execute on function evaluate_automations() from public, anon;
revoke execute on function recompute_doctor(uuid) from public, anon, authenticated;
revoke execute on function refresh_cohort_intervals() from public, anon, authenticated;
revoke execute on function log_audit(text, uuid, text, text, text) from public, anon, authenticated;
-- current_rol/is_manager/can_write/is_system quedan ejecutables por authenticated:
-- las evalúan las policies RLS con el rol del llamador.
revoke execute on function current_rol() from anon;
revoke execute on function is_manager() from anon;
revoke execute on function can_write() from anon;

-- ---------- pg_cron: nightly 05:00 México (11:00 UTC) + evaluador horario ----------
do $cron$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('crm-recompute-nightly', '0 11 * * *', 'select recompute_all()');
  perform cron.schedule('crm-automations-hourly', '10 * * * *', 'select evaluate_automations()');
exception when others then
  raise notice 'pg_cron no disponible (%). Programar recompute_all() y evaluate_automations() manualmente.', sqlerrm;
end $cron$;

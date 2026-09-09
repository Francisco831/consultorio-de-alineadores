-- Rollback de 0060. Primero devuelve el guard a la versión de 0058 y el
-- envoltorio del trigger de actividades a la de 0053 (los dos nombran las
-- columnas y la función nuevas: si se borran antes, el próximo UPDATE sobre
-- doctors o el próximo INSERT en activities fallan), y recién después borra.

-- 1. el envoltorio del trigger de actividades, como lo dejó 0053
create or replace function recompute_doctor_trigger() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_doctor uuid;
  v_previo text;
begin
  if tg_op = 'DELETE' then
    v_doctor := old.doctor_id;
  else
    v_doctor := new.doctor_id;
  end if;
  if v_doctor is not null then
    v_previo := coalesce(current_setting('app.system', true), '');
    perform recompute_doctor(v_doctor);
    perform set_config('app.system', v_previo, true);
  end if;
  return null;
end $fn$;

-- 2. el guard, como lo dejó 0058 (reaplicar el bloque 3 de 0058 es equivalente)
create or replace function doctors_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if tg_op = 'INSERT' then
    new.health_score := null;          new.health_factors := null;
    new.health_confidence := null;     new.potential_computed := null;
    new.priority_score := null;        new.priority_reasons := null;
    new.priority_bucket := null;       new.recommended_action := null;
    new.avg_interval_days := null;     new.expected_next_case_at := null;
    new.case_count := 0;               new.new_case_count := 0;
    new.first_case_at := null;         new.last_case_at := null;
    new.last_new_case_at := null;      new.last_contact_at := null;
    new.first_paid_case_at := null;    new.last_paid_case_at := null;
    new.days_to_first_case := null;    new.first_contact_at := null;
    new.first_meeting_at := null;
    new.is_accredited := false;        new.accredited_at := null;
    new.activated_by := null;          new.noloco_id := null;
    new.actividad_90d := null;         new.nuevos_90d := 0;
    new.posteriores_90d := 0;          new.servicio_90d := 0;
    new.ultimo_caso_posterior_at := null;
    new.segmento := null;              new.ultimo_caso_aprobado_at := null;
    new.is_demo := false;
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
  or new.lifecycle_stage       is distinct from old.lifecycle_stage
  or new.last_contact_at       is distinct from old.last_contact_at
  or new.actividad_90d            is distinct from old.actividad_90d
  or new.nuevos_90d               is distinct from old.nuevos_90d
  or new.posteriores_90d          is distinct from old.posteriores_90d
  or new.servicio_90d             is distinct from old.servicio_90d
  or new.ultimo_caso_posterior_at is distinct from old.ultimo_caso_posterior_at
  or new.segmento                 is distinct from old.segmento
  or new.ultimo_caso_aprobado_at  is distinct from old.ultimo_caso_aprobado_at
  then
    raise exception 'Esas columnas las calcula el sistema a partir de casos, pagos y actividades: se cambian registrando el hecho, no editando el número';
  end if;
  if new.is_accredited is distinct from old.is_accredited
  or new.accredited_at is distinct from old.accredited_at
  or new.activated_by is distinct from old.activated_by
  or new.noloco_id    is distinct from old.noloco_id
  then
    raise exception 'La acreditación se registra moviendo al doctor a "Acreditado" en el pipeline, no editando el campo';
  end if;
  if new.is_demo is distinct from old.is_demo then
    raise exception 'Marcar o desmarcar un doctor como demo no se hace desde la app: "Borrar datos demo" lo eliminaría con toda su historia';
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

-- 3. lo demás
do $$
begin
  perform cron.unschedule('crm-interaccion-nightly');
exception when others then
  raise notice 'cron.unschedule: %', sqlerrm;
end $$;

drop function if exists recompute_interaccion(uuid);
drop index if exists doctors_interaccion_idx;
drop index if exists wa_conversations_doctor_idx;
alter table doctors
  drop column if exists interaccion,
  drop column if exists wa_del_doctor,
  drop column if exists wa_nuestros,
  drop column if exists wa_dias,
  drop column if exists contactos_registrados,
  drop column if exists ultimo_wa_at;
delete from automation_rules where key = 'interaccion_soporte';

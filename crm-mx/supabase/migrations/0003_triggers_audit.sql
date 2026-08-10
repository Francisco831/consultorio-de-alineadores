-- 0003: helpers de rol, audit triggers, guardas de columnas y transiciones de negocio

-- ---------- rol del usuario actual (null = sistema/service role) ----------
create or replace function current_rol() returns user_role
language sql stable security definer set search_path = public as $$
  select rol from profiles where id = auth.uid()
$$;

create or replace function is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_rol() in ('ADMIN','COUNTRY_MANAGER','SALES_MANAGER'), false)
$$;

-- "sistema" = sin sesión (service role / cron) o funciones internas que setean app.system
create or replace function is_system() returns boolean
language sql stable as $$
  select auth.uid() is null or coalesce(current_setting('app.system', true), '') = 'on'
$$;

-- ---------- audit helper ----------
create or replace function log_audit(
  p_entity text, p_id uuid, p_field text, p_old text, p_new text
) returns void
language sql security definer set search_path = public as $$
  insert into audit_log (entity_type, entity_id, field, old_value, new_value, actor_id, source)
  values (
    p_entity, p_id, p_field, p_old, p_new, auth.uid(),
    coalesce(nullif(current_setting('app.source', true), ''), 'app')
  )
$$;

-- ---------- profile automático al crear usuario en auth ----------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rol user_role;
begin
  -- rol SOLO desde app_metadata (lo setea el admin API / server; el cliente NO puede
  -- setearlo en signup). user_metadata es controlado por el cliente => nunca autoriza.
  -- El CASE valida contra el enum: metadata malformada cae a VIEWER en vez de abortar
  -- el alta en auth.users con un cast fallido.
  v_rol := (case new.raw_app_meta_data->>'rol'
    when 'ADMIN'           then 'ADMIN'
    when 'COUNTRY_MANAGER' then 'COUNTRY_MANAGER'
    when 'SALES_MANAGER'   then 'SALES_MANAGER'
    when 'SALES'           then 'SALES'
    when 'CLINICAL'        then 'CLINICAL'
    else 'VIEWER'
  end)::user_role;

  insert into profiles (id, nombre, rol)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    v_rol
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- doctors: guarda de columnas sensibles + audit ----------
create or replace function doctors_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- un alta desde el cliente entra con los campos calculados vacíos
    new.health_score := null;          new.health_factors := null;
    new.health_confidence := null;     new.potential_computed := null;
    new.priority_score := null;        new.priority_reasons := null;
    new.priority_bucket := null;       new.recommended_action := null;
    new.avg_interval_days := null;     new.expected_next_case_at := null;
    new.case_count := 0;               new.new_case_count := 0;
    new.first_case_at := null;         new.last_case_at := null;
    new.last_new_case_at := null;
    if not is_manager() then
      new.potential_override := null;
    end if;
    return new;
  end if;
  -- columnas cacheadas de score: solo el sistema las escribe
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
  then
    raise exception 'Las columnas de score las calcula el sistema';
  end if;
  -- columnas de gestión: solo managers
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

create trigger doctors_guard_trg
  before insert or update on doctors
  for each row execute function doctors_guard();

create or replace function doctors_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lifecycle_stage is distinct from old.lifecycle_stage then
    perform log_audit('doctor', new.id, 'lifecycle_stage', old.lifecycle_stage::text, new.lifecycle_stage::text);
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform log_audit('doctor', new.id, 'owner_id', old.owner_id::text, new.owner_id::text);
  end if;
  if new.categoria is distinct from old.categoria then
    perform log_audit('doctor', new.id, 'categoria', old.categoria::text, new.categoria::text);
  end if;
  if new.potential_override is distinct from old.potential_override then
    perform log_audit('doctor', new.id, 'potential_override', old.potential_override::text, new.potential_override::text);
  end if;
  return new;
end $$;

create trigger doctors_audit_trg
  after update on doctors
  for each row execute function doctors_audit();

-- ---------- opportunities: transiciones de etapa + audit ----------
create or replace function opportunities_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_entered_at = now();
    if new.stage = 'ganada' then
      new.closed_at = now();
      new.forecast_category = 'closed';
      new.probability = 100;
    elsif new.stage = 'perdida' then
      new.closed_at = now();
      new.forecast_category = 'omitted';
      new.probability = 0;
    end if;
  end if;
  -- probabilidad default por etapa si no viene seteada
  if new.probability is null then
    new.probability = case new.stage
      when 'paciente_potencial' then 10
      when 'documentacion'      then 25
      when 'caso_ingresado'     then 40
      when 'planificacion'      then 50
      when 'presentada'         then 60
      when 'decision'           then 70
      when 'compromiso'         then 90
      when 'ganada'             then 100
      when 'perdida'            then 0
    end;
  end if;
  return new;
end $$;

create trigger opportunities_transition_trg
  before insert or update on opportunities
  for each row execute function opportunities_transition();

create or replace function opportunities_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage is distinct from old.stage then
    perform log_audit('opportunity', new.id, 'stage', old.stage::text, new.stage::text);
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform log_audit('opportunity', new.id, 'owner_id', old.owner_id::text, new.owner_id::text);
  end if;
  if new.forecast_category is distinct from old.forecast_category then
    perform log_audit('opportunity', new.id, 'forecast_category', old.forecast_category::text, new.forecast_category::text);
  end if;
  return new;
end $$;

create trigger opportunities_audit_trg
  after update on opportunities
  for each row execute function opportunities_audit();

-- ---------- tasks: completed_at + audit ----------
create or replace function tasks_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'completada' then
      new.completed_at = coalesce(new.completed_at, now());
    end if;
  end if;
  return new;
end $$;

create trigger tasks_transition_trg
  before update on tasks
  for each row execute function tasks_transition();

create or replace function tasks_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    perform log_audit('task', new.id, 'status', old.status::text, new.status::text);
  end if;
  return new;
end $$;

create trigger tasks_audit_trg
  after update on tasks
  for each row execute function tasks_audit();

-- 0004: RLS — transparencia total de lectura, escritura por rol, sistema por fuera
--
-- Principios:
--  * Todos los autenticados leen todo (el equipo se ve entre sí por diseño).
--  * Escritura operacional: cualquier rol menos VIEWER.
--  * goals / automation_rules / campaigns / custom_field_defs / roles: solo managers.
--  * DELETE: solo managers (salvo saved_views propias).
--  * cases / payments / audit_log / score_snapshots / sync_runs / wa_*: sin policies de
--    escritura para clientes → solo service role (import/cron) puede escribir.

-- ---------- habilitar RLS en todo ----------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','campaigns','doctors','contacts','cases','payments','opportunities',
    'automation_rules','alerts','tasks','activities','audit_log','score_snapshots',
    'segments','saved_views','goals','custom_field_defs','wa_conversations',
    'wa_messages','sync_runs'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------- lectura: todos los autenticados ----------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','campaigns','doctors','contacts','cases','payments','opportunities',
    'automation_rules','alerts','tasks','activities','audit_log','score_snapshots',
    'segments','saved_views','goals','custom_field_defs','wa_conversations',
    'wa_messages','sync_runs'
  ] loop
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_select', t
    );
  end loop;
end $$;

-- ---------- escritura operacional: no-VIEWER ----------
create or replace function can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_rol() is not null and current_rol() <> 'VIEWER', false)
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'doctors','contacts','opportunities','activities','tasks','segments'
  ] loop
    execute format(
      'create policy %I on %I for insert to authenticated with check (can_write())',
      t || '_insert', t
    );
    execute format(
      'create policy %I on %I for update to authenticated using (can_write()) with check (can_write())',
      t || '_update', t
    );
    execute format(
      'create policy %I on %I for delete to authenticated using (is_manager())',
      t || '_delete', t
    );
  end loop;
end $$;

-- alerts: el sistema las crea; los usuarios solo las resuelven/descartan
create policy alerts_update on alerts
  for update to authenticated using (can_write()) with check (can_write());

-- guarda: desde el cliente solo se tocan status/resolved_*; el resto es del sistema
create or replace function alerts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if new.id             is distinct from old.id
  or new.rule_key       is distinct from old.rule_key
  or new.doctor_id      is distinct from old.doctor_id
  or new.opportunity_id is distinct from old.opportunity_id
  or new.severity       is distinct from old.severity
  or new.title          is distinct from old.title
  or new.reason         is distinct from old.reason
  or new.is_demo        is distinct from old.is_demo
  or new.created_at     is distinct from old.created_at
  then
    raise exception 'Las alertas solo se resuelven o descartan desde la app';
  end if;
  return new;
end $$;

create trigger alerts_guard_trg
  before update on alerts
  for each row execute function alerts_guard();

-- ---------- saved_views: cada uno gestiona las suyas ----------
create policy saved_views_insert on saved_views
  for insert to authenticated with check (user_id = auth.uid());
create policy saved_views_update on saved_views
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy saved_views_delete on saved_views
  for delete to authenticated using (user_id = auth.uid() or is_manager());

-- ---------- profiles: cada uno edita su fila; managers editan todas ----------
create policy profiles_update_own on profiles
  for update to authenticated
  using (id = auth.uid() or is_manager())
  with check (id = auth.uid() or is_manager());

-- guarda: el rol solo lo cambian managers (aunque edites tu propia fila)
create or replace function profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if new.rol is distinct from old.rol and not is_manager() then
    raise exception 'Solo un manager puede cambiar roles';
  end if;
  return new;
end $$;

create trigger profiles_guard_trg
  before update on profiles
  for each row execute function profiles_guard();

-- ---------- tablas de manager ----------
do $$
declare t text;
begin
  foreach t in array array['goals','campaigns','custom_field_defs'] loop
    execute format(
      'create policy %I on %I for insert to authenticated with check (is_manager())',
      t || '_insert', t
    );
    execute format(
      'create policy %I on %I for update to authenticated using (is_manager()) with check (is_manager())',
      t || '_update', t
    );
    execute format(
      'create policy %I on %I for delete to authenticated using (is_manager())',
      t || '_delete', t
    );
  end loop;
end $$;

-- automation_rules: managers editan (enabled/params); nadie borra desde el cliente
create policy automation_rules_update on automation_rules
  for update to authenticated using (is_manager()) with check (is_manager());

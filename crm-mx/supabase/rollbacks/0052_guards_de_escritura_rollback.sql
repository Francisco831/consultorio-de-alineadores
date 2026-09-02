-- Rollback de 0052. Devuelve las cuatro puertas al estado anterior.
--
-- OJO con qué significa correr esto: vuelve a permitir que una sesión marque un
-- doctor real como demo (y "Borrar datos demo" lo elimine con su historia),
-- reescriba columnas calculadas, le saque a una tarea la marca que hace cumplir
-- el cupo, y borre eventos ajenos. Es un rollback de disponibilidad —para el día
-- que un guard resulte más estrecho que el producto y frene trabajo real—, no un
-- camino de vuelta cómodo. Si el problema es UNA columna, es mejor sumarla a la
-- lista blanca del guard que apagar los cuatro.

-- 1. doctors: la versión de 0019, sin is_demo/lifecycle_stage/last_contact_at
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

-- 2 y 3. los guards nuevos
drop trigger if exists tasks_guard_trg on tasks;
drop function if exists tasks_guard();
drop trigger if exists opportunities_guard_trg on opportunities;
drop function if exists opportunities_guard();

-- 4. borrar eventos: como estaba en 0035
drop policy if exists events_delete on events;
create policy events_delete on events for delete to authenticated using (can_write());
drop policy if exists event_attendees_delete on event_attendees;
create policy event_attendees_delete on event_attendees for delete to authenticated using (can_write());

-- 5. calendar_events: como estaba en 0046
create policy calendar_events_insert on calendar_events
  for insert to authenticated with check (can_write());
create policy calendar_events_update on calendar_events
  for update to authenticated using (can_write()) with check (can_write());
create policy calendar_events_delete on calendar_events
  for delete to authenticated using (can_write());

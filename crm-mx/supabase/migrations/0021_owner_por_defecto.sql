-- 0021: las tareas de las automatizaciones caían en el vacío.
--
-- Se asignaban a doctors.owner_id, pero los 6.208 prospectos del universo A no
-- tienen dueño (se cargaron de las planillas). Resultado: assigned_to = NULL y
-- la tarea no aparece en "Mías" de nadie.
--
-- Hoy el equipo comercial de México es UNA persona (Juan). Mientras haya un
-- solo vendedor activo, la tarea sin dueño es suya. Si algún día hay varios,
-- la función devuelve NULL y se decide asignando el doctor a un owner.

create or replace function default_sales_owner() returns uuid
language sql stable security definer set search_path = public as $$
  -- solo si hay exactamente UN vendedor activo: con dos o más, adivinar sería peor
  -- (min() no existe para uuid, de ahí el array_agg)
  select case when count(*) = 1 then (array_agg(id))[1] end
  from profiles
  where rol = 'SALES' and activo
$$;

revoke execute on function default_sales_owner() from public, anon;
grant execute on function default_sales_owner() to authenticated, service_role;

-- las tareas abiertas que quedaron huérfanas pasan al vendedor
update tasks
set assigned_to = default_sales_owner()
where assigned_to is null
  and status = 'pendiente'
  and default_sales_owner() is not null;

-- y las que se creen de ahora en más
create or replace function tasks_default_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is null then
    new.assigned_to := default_sales_owner();
  end if;
  return new;
end $$;

drop trigger if exists tasks_default_owner_trg on tasks;
create trigger tasks_default_owner_trg
  before insert on tasks
  for each row execute function tasks_default_owner();

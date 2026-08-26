-- 0039 — Pendientes del día: la libreta personal de cada uno (Juan, Rocío, Pancho).
--
-- Pedido de Pancho en la reunión del 26/8: "haceme un lugar para cada uno donde
-- puedan anotar sus tareas diarias o pendientes, tipo Trello, bien simple, en la
-- página principal".
--
-- POR QUÉ NO ES `tasks`. `tasks` es la cola COMERCIAL del CRM: la llenan las
-- automatizaciones (la migración 0020 existe porque una de ellas generó 4.945
-- filas de golpe), alimenta el KPI "Tareas completadas" del panel y su policy de
-- delete es solo para managers — nadie podría borrar su propia nota. Además /hoy
-- filtra tareas por `due_date <= hoy`, así que un pendiente sin fecha ni
-- aparecería. Una libreta es otra cosa: se escribe, se tacha y se borra, y no
-- mide a nadie.
--
-- Rollback: supabase/rollbacks/0039_pendientes_rollback.sql

create table if not exists pendientes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  texto text not null check (length(btrim(texto)) between 1 and 500),
  hecho boolean not null default false,
  hecho_at timestamptz,
  -- orden manual: el alta nueva va arriba (orden negativo descendente), y si
  -- algún día se arrastra con @dnd-kit (ya es dependencia) alcanza con reescribirlo
  orden integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- calca la query de /hoy: los míos, sin tachar primero, por orden
create index if not exists pendientes_user_idx on pendientes (user_id, hecho, orden, created_at);

drop trigger if exists pendientes_updated_at on pendientes;
create trigger pendientes_updated_at
  before update on pendientes
  for each row execute function set_updated_at();

-- tachar deja marca de cuándo sin que la app tenga que mandarla
create or replace function pendientes_transition() returns trigger
language plpgsql as $$
begin
  if new.hecho is distinct from old.hecho then
    new.hecho_at = case when new.hecho then now() else null end;
  end if;
  return new;
end $$;

drop trigger if exists pendientes_transition_trg on pendientes;
create trigger pendientes_transition_trg
  before update on pendientes
  for each row execute function pendientes_transition();

alter table pendientes enable row level security;

-- lectura: todos ven todo, como en el resto del CRM (decisión de Pancho 8/8) —
-- /panel ya muestra el panel de cualquiera con ?u=
drop policy if exists pendientes_select on pendientes;
create policy pendientes_select on pendientes
  for select to authenticated using (true);

-- escritura: SOLO los propios (mismo patrón que saved_views en 0004)
drop policy if exists pendientes_insert on pendientes;
create policy pendientes_insert on pendientes
  for insert to authenticated with check (user_id = auth.uid() and can_write());
drop policy if exists pendientes_update on pendientes;
create policy pendientes_update on pendientes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists pendientes_delete on pendientes;
create policy pendientes_delete on pendientes
  for delete to authenticated using (user_id = auth.uid() or is_manager());

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'pendientes') then
    raise exception 'pendientes quedó sin policies';
  end if;
  raise notice '0039 OK: pendientes creada con RLS por dueño';
end $$;

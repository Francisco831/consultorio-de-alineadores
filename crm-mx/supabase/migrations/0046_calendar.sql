-- 0046 — Agenda de Google Calendar por persona (pedido de Pancho 26/8/26:
-- "antes de cada llamada quiero saber a quién estoy por llamar").
--
-- La llena /api/sync/calendar leyendo el Apps Script que cada persona despliega
-- en SU cuenta (gas-calendar.gs). Nadie la escribe a mano: es un espejo del
-- calendario, y por eso la clave real es (profile_id, google_event_id) —
-- reimportar la misma agenda diez veces tiene que ser no-op.
--
-- POR QUÉ NO SE REUSA `events` (0035). Esa tabla es otra cosa: son los eventos
-- ACADÉMICOS grupales (charlas, webinars, KeepDays, acreditaciones) que se
-- cargan a mano con su lista de asistentes. Tres razones concretas por las que
-- no entra una agenda personal ahí:
--   1. events.fecha es `date`, sin hora. Una agenda del día sin hora no sirve
--      para nada: lo primero que se mira es "a las 11:30 con quién".
--   2. events no tiene dueño (organizador) ni id externo, así que no habría
--      forma de decir "esto es de Rocío" ni de deduplicar contra Google.
--   3. Contaminaría /eventos y el tile "eventos del mes" del panel: cada
--      dentista, cada reunión interna y cada turno personal de quien conecte su
--      calendario pasaría a contarse como actividad académica de KeepSmiling.
-- Son dos tablas porque son dos hechos distintos, no por comodidad.
--
-- Rollback: supabase/rollbacks/0046_calendar_rollback.sql

create table if not exists calendar_events (
  id uuid primary key default gen_random_uuid(),
  -- de quién es la agenda (hoy Rocío; la terna de envs se repite por persona)
  profile_id uuid not null references profiles(id) on delete cascade,
  google_event_id text not null,
  titulo text not null,
  inicio timestamptz not null,
  fin timestamptz,
  todo_el_dia boolean not null default false,
  -- el doctor lo resuelve el sync; queda null cuando no se pudo saber SIN
  -- adivinar (dos candidatos con el mismo apellido = null, no el primero)
  doctor_id uuid references doctors(id) on delete set null,
  -- 'email' | 'titulo' | null — para poder auditar por qué se vinculó
  match_source text,
  -- el evento crudo tal como lo devolvió Apps Script: si mañana el match mejora,
  -- se puede recalcular sin volver a pegarle a Google
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, google_event_id)
);

-- calca la query de la agenda del día: la mía, ordenada por hora
create index if not exists calendar_events_profile_inicio_idx
  on calendar_events (profile_id, inicio);
create index if not exists calendar_events_doctor_idx
  on calendar_events (doctor_id);

drop trigger if exists calendar_events_updated_at on calendar_events;
create trigger calendar_events_updated_at
  before update on calendar_events
  for each row execute function set_updated_at();

alter table calendar_events enable row level security;

-- RLS calcada de 0035_events.sql: lee todo el equipo (decisión de Pancho 8/8 —
-- acá todos ven todo), escribe quien puede escribir. En los hechos la escritura
-- la hace el sync con service role; las policies están para que un día se pueda
-- corregir un vínculo desde la app sin abrir la tabla entera.
drop policy if exists calendar_events_select on calendar_events;
create policy calendar_events_select on calendar_events
  for select to authenticated using (true);
drop policy if exists calendar_events_insert on calendar_events;
create policy calendar_events_insert on calendar_events
  for insert to authenticated with check (can_write());
drop policy if exists calendar_events_update on calendar_events;
create policy calendar_events_update on calendar_events
  for update to authenticated using (can_write()) with check (can_write());
drop policy if exists calendar_events_delete on calendar_events;
create policy calendar_events_delete on calendar_events
  for delete to authenticated using (can_write());

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'calendar_events') then
    raise exception 'calendar_events quedó sin policies';
  end if;
  raise notice '0046 OK: calendar_events creada con RLS y única por (profile_id, google_event_id)';
end $$;

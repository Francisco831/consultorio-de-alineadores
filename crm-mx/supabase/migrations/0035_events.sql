-- 0035 — Eventos con asistentes y dictante (pedido de Pancho 19/8).
--
-- El intranet registra eventos 1-a-1 (contact points) pero NO eventos grupales:
-- api/events no tiene ni asistentes ni dictante (verificado 19/8). Charlas,
-- webinars, acreditaciones y KeepDays con más de un doctor no viven en ningún
-- sistema — por eso la tabla propia. El asistente guarda doctor_id cuando el
-- nombre matcheó contra doctors y SIEMPRE el nombre crudo tipeado: un doctor
-- que todavía no existe en el CRM no puede hacer perder el registro.

create table events (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  tipo text not null default 'charla',   -- charla | webinar | keepday | acreditacion | otro
  fecha date not null,
  dictante text,                         -- quién dictó (Rocío, un KOL, etc.)
  modalidad text,                        -- Presencial | Virtual
  notas text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index events_fecha_idx on events (fecha desc);

create table event_attendees (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  doctor_id uuid references doctors(id) on delete set null,
  nombre_crudo text not null,
  created_at timestamptz not null default now()
);
create index event_attendees_event_idx on event_attendees (event_id);
create index event_attendees_doctor_idx on event_attendees (doctor_id);

alter table events enable row level security;
alter table event_attendees enable row level security;

create policy events_select on events for select to authenticated using (true);
create policy events_insert on events for insert to authenticated with check (can_write());
create policy events_update on events for update to authenticated using (can_write()) with check (can_write());
create policy events_delete on events for delete to authenticated using (can_write());

create policy event_attendees_select on event_attendees for select to authenticated using (true);
create policy event_attendees_insert on event_attendees for insert to authenticated with check (can_write());
create policy event_attendees_delete on event_attendees for delete to authenticated using (can_write());

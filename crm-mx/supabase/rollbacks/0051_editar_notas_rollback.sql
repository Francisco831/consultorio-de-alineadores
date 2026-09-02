-- Rollback de 0051_editar_notas.sql
--
-- ANTES DE CORRERLO: bajá primero el código que usa esto. Si la app queda
-- desplegada contra una base sin 0051, dos cosas se rompen en caliente:
--   · el cron de actividades pide `sync_key` explícitamente
--     (lib/actividades-sync.ts) y `fetchAll` tira al no encontrar la columna;
--   · los botones de corregir siguen en pantalla y fallan al guardar.
--
-- LO QUE SE PIERDE: el rastro de quién corrigió qué (edited_at/edited_by). El
-- texto viejo NO se pierde: queda en audit_log, que es append-only.
--
-- OJO 1 — la puerta queda MÁS abierta que con 0051 puesta, no más cerrada:
--   `activities_update` es de 0004 y nunca la tocó esta migración, así que sigue
--   siendo `can_write()`. Sin el guard, cualquier no-VIEWER vuelve a poder
--   reescribir el summary, la fecha, el tipo, el doctor, el autor y el is_demo
--   de la actividad de CUALQUIERA —por PostgREST, sin pantalla— y sin dejar
--   rastro. Era el estado anterior a 0051, pero conviene saberlo: la migración
--   no abrió esa puerta, la encontró abierta y le puso llave.
--   Mismo caso en events_update, que vuelve a `can_write()` para todos.
--
-- OJO 2 — las notas que se hayan corregido mientras 0051 estuvo viva quedan con
--   un summary que ya no coincide con la clave por texto del dedup. Al volver el
--   cron a esa clave, la corrida siguiente las inserta de nuevo. Es el bug de
--   las ×4 copias del 20/8. Si ya hubo correcciones, revisá duplicados después.

drop trigger if exists activities_audit_trg on activities;
drop function if exists activities_audit();

drop trigger if exists activities_edicion_guard_trg on activities;
drop function if exists activities_edicion_guard();

drop trigger if exists activities_sync_key_trg on activities;
drop function if exists activities_set_sync_key();

-- el recompute vuelve a ser uno solo, disparando en todo update
drop trigger if exists activities_recompute_upd_trg on activities;
drop trigger if exists activities_recompute_trg on activities;
create trigger activities_recompute_trg
  after insert or update or delete on activities
  for each row execute function recompute_doctor_trigger();

alter table activities drop column if exists edited_at;
alter table activities drop column if exists edited_by;
alter table activities drop column if exists sync_key;

drop trigger if exists events_guard_trg on events;
drop function if exists events_guard();

drop policy if exists events_update on events;
create policy events_update on events for update to authenticated
  using (can_write()) with check (can_write());

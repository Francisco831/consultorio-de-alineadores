-- Rollback de 0046_calendar.sql
-- La tabla es un espejo del Google Calendar: borrarla no pierde nada propio,
-- la próxima corrida de /api/sync/calendar la vuelve a llenar.
drop table if exists calendar_events;

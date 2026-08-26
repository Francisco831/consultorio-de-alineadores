-- Rollback de 0039_pendientes.sql
drop table if exists pendientes;
drop function if exists pendientes_transition();

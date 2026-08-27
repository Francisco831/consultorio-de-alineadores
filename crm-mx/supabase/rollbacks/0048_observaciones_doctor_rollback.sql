-- Rollback de 0048_observaciones_doctor.sql
-- OJO: borra las notas escritas a mano. No hay dónde recuperarlas.
alter table doctors drop column if exists observaciones;

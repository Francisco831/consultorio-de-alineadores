-- Rollback de 0049_zonas_mx.sql
--
-- Devuelve state y zona exactamente como estaban: los valores salen de
-- ops.geo_0049_backup, que 0049 llenó antes de tocar nada. Vuelve, por lo tanto,
-- el vocabulario viejo (CDMX / Norte / Sur / Foráneos) y los 564 "estados" que
-- decían whatsapp o No contesta.
--
-- OJO: si el equipo cargó estados o zonas a mano DESPUÉS de aplicar 0049, esto
-- los pisa con la foto vieja. Mirar antes:
--   select count(*) from doctors d join ops.geo_0049_backup b on b.doctor_id = d.id
--    where d.state is distinct from b.state_old or d.zona is distinct from b.zona_old;

alter table doctors drop constraint if exists doctors_zona_valida;

update doctors d
   set state = b.state_old,
       zona  = b.zona_old,
       custom = d.custom - 'estado_crudo'
  from ops.geo_0049_backup b
 where b.doctor_id = d.id;

-- Fichas que no estaban en la foto (state y zona nulos entonces) pero que
-- pudieron quedar con la clave archivada por una corrida posterior.
update doctors set custom = custom - 'estado_crudo' where custom ? 'estado_crudo';

comment on column doctors.zona is null;
comment on column doctors.state is null;

drop table if exists ops.geo_0049_backup;

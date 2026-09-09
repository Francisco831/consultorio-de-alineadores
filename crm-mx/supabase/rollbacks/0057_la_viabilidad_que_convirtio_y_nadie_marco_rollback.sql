-- Rollback de 0057. Saca el cron y las dos funciones. Lo que ya vinculó NO se
-- deshace solo: cada viabilidad que pasó a ganada tiene case_id, closed_at =
-- ingreso del caso y viability_completed_at; volverlas atrás es decidir, una
-- por una, si el cruce estaba mal — y si lo estaba, el lugar para arreglar el
-- criterio es la función, no borrar el vínculo.
--
--   update opportunities set stage = 'viabilidad', case_id = null, closed_at = null,
--          viability_completed_at = null
--    where id = '<la que haya que deshacer>';
do $$
begin
  perform cron.unschedule('crm-viabilidades-vinculo');
exception when others then
  raise notice 'cron.unschedule: %', sqlerrm;
end $$;

drop function if exists vincular_viabilidades();
drop function if exists viab_tokens(text);

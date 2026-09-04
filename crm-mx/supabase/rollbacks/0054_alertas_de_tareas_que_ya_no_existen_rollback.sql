-- Rollback de 0054. Las alertas cerradas NO se reabren: eran falsas.
-- Si hiciera falta reabrirlas (no debería), el criterio es
--   update alerts set status='abierta', resolved_at=null
--    where rule_key='tarea_vencida' and status='descartada' and resolved_at > '<fecha de la migración>';
do $$
begin
  perform cron.unschedule('crm-alertas-huerfanas');
exception when others then
  raise notice 'cron.unschedule: %', sqlerrm;
end $$;

drop function if exists cerrar_alertas_huerfanas();

-- Rollback de 0056.
do $$
begin
  perform cron.unschedule('crm-se-apaga');
exception when others then
  raise notice 'cron.unschedule: %', sqlerrm;
end $$;

update alerts set status = 'descartada', resolved_at = now()
 where rule_key = 'se_apaga' and status = 'abierta';
update tasks set status = 'cancelada'
 where status = 'pendiente'
   and automation_rule_id = (select id from automation_rules where key = 'se_apaga');

drop function if exists evaluar_se_apaga();
delete from automation_rules where key = 'se_apaga';

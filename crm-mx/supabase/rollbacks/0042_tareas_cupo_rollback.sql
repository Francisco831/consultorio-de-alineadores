-- Rollback de 0042_tareas_cupo.sql
-- OJO: no resucita las tareas canceladas por la limpieza (ni debería).
drop trigger if exists tasks_z_cupo_automatico_trg on tasks;
drop function if exists tasks_cupo_automatico();
update automation_rules
   set params = jsonb_set(coalesce(params,'{}'::jsonb), '{max_per_run}', '25'::jsonb)
 where key = 'prospecto_sin_seguimiento';

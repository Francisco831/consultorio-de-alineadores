-- Rollback de 0055. Deja el guard como lo dejó 0052 (reaplicar 0052 alcanza:
-- es la versión sin las cinco columnas del eje).
do $$
begin
  perform cron.unschedule('crm-actividad-nightly');
exception when others then
  raise notice 'cron.unschedule: %', sqlerrm;
end $$;

drop function if exists recompute_actividad();
drop index if exists doctors_actividad_idx;
alter table doctors
  drop column if exists actividad_90d,
  drop column if exists nuevos_90d,
  drop column if exists posteriores_90d,
  drop column if exists servicio_90d,
  drop column if exists ultimo_caso_posterior_at;

-- y después: \i supabase/migrations/0052_guards_de_escritura.sql

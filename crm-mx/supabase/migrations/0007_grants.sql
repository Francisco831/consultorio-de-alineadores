-- 0007: grants de esquema (proyectos Supabase nuevos no traen default privileges
-- para tablas creadas por conexión directa). La autorización REAL es RLS + guards:
-- estos grants solo habilitan el paso por PostgREST.
grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- anon: sin acceso a tablas (login-only app); RLS igual lo bloquearía.

grant usage, select on all sequences in schema public to authenticated, service_role;

-- futuros objetos creados por postgres heredan lo mismo
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to authenticated, service_role;

-- funciones de mantenimiento: scripts (service_role) y managers (guard interno)
grant execute on function recompute_all() to service_role, authenticated;
grant execute on function evaluate_automations() to service_role, authenticated;
grant execute on function purge_demo() to service_role, authenticated;
grant execute on function recompute_doctor(uuid) to service_role;
grant execute on function refresh_cohort_intervals() to service_role;

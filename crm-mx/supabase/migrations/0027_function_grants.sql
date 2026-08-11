-- 0027: cerrar el EXECUTE que Postgres concede a PUBLIC al crear una función.
--
-- Hallazgo CRIT-01 de AUDITORIA_CRM.md: 30 de las 39 funciones SECURITY DEFINER
-- de public conservan EXECUTE para PUBLIC, y `anon` hereda de PUBLIC. Doce de ellas
-- devuelven datos del negocio por HTTP sin sesión, dos con nombre de paciente.
--
-- El patrón correcto ya estaba escrito en 0026:199 para una sola función; acá se
-- aplica a las 39. Y el error de 0006:309-311 —`revoke ... from anon` sin tocar
-- PUBLIC, que no hace nada— queda corregido de paso.
--
-- Las firmas se generaron desde pg_proc, no a mano: una firma mal escrita no
-- revoca nada y da falsa tranquilidad.
--
-- Rollback: supabase/rollbacks/0027_function_grants_rollback.sql
-- Idempotente: revoke y grant se pueden repetir sin efecto acumulativo.

-- ---------------------------------------------------------------------------
-- 1. Cerrar todo. `from public, anon`: PUBLIC por el default de Postgres, anon
--    por si alguna vez recibió un grant directo.
-- ---------------------------------------------------------------------------

-- invocables como RPC
revoke all on function ai_accredited_not_activated(integer)                           from public, anon;
revoke all on function ai_at_risk_doctors(integer)                                    from public, anon;
revoke all on function ai_cases_by_period(date,date)                                  from public, anon;
revoke all on function ai_data_quality()                                              from public, anon;
revoke all on function ai_doctor_segments()                                           from public, anon;
revoke all on function ai_dormant_doctors(integer,boolean)                            from public, anon;
revoke all on function ai_forecast(date)                                              from public, anon;
revoke all on function ai_pipeline_summary(date,integer)                              from public, anon;
revoke all on function ai_prospects(text,integer,text,text,integer)                   from public, anon;
revoke all on function ai_rep_performance(integer,date)                               from public, anon;
revoke all on function ai_second_case_metrics()                                       from public, anon;
revoke all on function ai_service_issues(integer,uuid)                                from public, anon;
revoke all on function can_write()                                                    from public, anon;
revoke all on function case_self_similarity(uuid)                                     from public, anon;
revoke all on function current_rol()                                                  from public, anon;
revoke all on function default_sales_owner()                                          from public, anon;
revoke all on function evaluate_automations()                                         from public, anon;
revoke all on function evento_roi()                                                   from public, anon;
revoke all on function is_manager()                                                   from public, anon;
revoke all on function log_audit(text,uuid,text,text,text)                            from public, anon;
revoke all on function purge_demo()                                                   from public, anon;
revoke all on function recompute_all()                                                from public, anon;
revoke all on function recompute_doctor(uuid)                                         from public, anon;
revoke all on function refresh_cohort_intervals()                                     from public, anon;

-- funciones de trigger (PostgREST no las expone, pero no deben ser públicas)
revoke all on function activities_default_engagement()                                from public, anon;
revoke all on function activities_engagement_guard()                                  from public, anon;
revoke all on function ai_recommendations_guard()                                     from public, anon;
revoke all on function alerts_guard()                                                 from public, anon;
revoke all on function cases_subject_guard()                                          from public, anon;
revoke all on function doctors_audit()                                                from public, anon;
revoke all on function doctors_guard()                                                from public, anon;
revoke all on function doctors_journey_sync()                                         from public, anon;
revoke all on function handle_new_user()                                              from public, anon;
revoke all on function opportunities_audit()                                          from public, anon;
revoke all on function opportunities_transition()                                     from public, anon;
revoke all on function profiles_guard()                                               from public, anon;
revoke all on function recompute_doctor_trigger()                                     from public, anon;
revoke all on function tasks_audit()                                                  from public, anon;
revoke all on function tasks_default_owner()                                          from public, anon;

-- ---------------------------------------------------------------------------
-- 2. Volver a conceder por lista explícita.
--    Las de trigger NO llevan grant: Postgres verifica EXECUTE al CREAR el
--    trigger, no al dispararlo.
-- ---------------------------------------------------------------------------

grant execute on function ai_accredited_not_activated(integer)                           to authenticated, service_role;
grant execute on function ai_at_risk_doctors(integer)                                    to authenticated, service_role;
grant execute on function ai_cases_by_period(date,date)                                  to authenticated, service_role;
grant execute on function ai_data_quality()                                              to authenticated, service_role;
grant execute on function ai_doctor_segments()                                           to authenticated, service_role;
grant execute on function ai_dormant_doctors(integer,boolean)                            to authenticated, service_role;
grant execute on function ai_forecast(date)                                              to authenticated, service_role;
grant execute on function ai_pipeline_summary(date,integer)                              to authenticated, service_role;
grant execute on function ai_prospects(text,integer,text,text,integer)                   to authenticated, service_role;
grant execute on function ai_rep_performance(integer,date)                               to authenticated, service_role;
grant execute on function ai_second_case_metrics()                                       to authenticated, service_role;
grant execute on function ai_service_issues(integer,uuid)                                to authenticated, service_role;
grant execute on function can_write()                                                    to authenticated, service_role;
grant execute on function case_self_similarity(uuid)                                     to authenticated, service_role;
grant execute on function current_rol()                                                  to authenticated, service_role;
grant execute on function default_sales_owner()                                          to authenticated, service_role;
grant execute on function evaluate_automations()                                         to authenticated, service_role;
grant execute on function evento_roi()                                                   to authenticated, service_role;
grant execute on function is_manager()                                                   to authenticated, service_role;
-- log_audit(text,uuid,text,text,text): sin grant a propósito (solo el dueño la ejecuta)
grant execute on function purge_demo()                                                   to authenticated, service_role;
grant execute on function recompute_all()                                                to authenticated, service_role;
grant execute on function recompute_doctor(uuid)                                         to service_role;
grant execute on function refresh_cohort_intervals()                                     to service_role;

-- ---------------------------------------------------------------------------
-- 3. Que las próximas no nazcan públicas.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 4. La migración se verifica a sí misma: si quedó una abierta, no se aplica.
-- ---------------------------------------------------------------------------
do $$
declare n int; lista text;
begin
  select count(*), string_agg(p.oid::regprocedure::text, ', ')
    into n, lista
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
  where ns.nspname = 'public' and d.objid is null and p.prosecdef
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if n > 0 then
    raise exception 'Quedan % funciones SECURITY DEFINER ejecutables por anon: %', n, lista;
  end if;
  raise notice '0027 OK: ninguna funcion SECURITY DEFINER de public es ejecutable por anon';
end $$;


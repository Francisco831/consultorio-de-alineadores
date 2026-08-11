-- Rollback de 0027_function_grants.sql — variante SEGURA.
--
-- QUÉ REVIERTE Y QUÉ NO
--
-- 0027 hizo dos cosas a la vez:
--   (a) cerró EXECUTE para PUBLIC/anon en las 39 funciones SECURITY DEFINER;
--   (b) volvió a conceder EXECUTE a authenticated/service_role por lista explícita.
--
-- Este archivo revierte SOLO (b): devuelve a `authenticated` y `service_role` el
-- EXECUTE de todo lo que la aplicación puede necesitar legítimamente, con la lista
-- más amplia posible. NO revierte (a): PUBLIC y anon siguen cerrados.
--
-- Por qué no restaura el estado exacto anterior: el estado anterior era el hallazgo
-- CRIT-01 —30 funciones ejecutables sin sesión, 12 devolviendo datos del negocio por
-- HTTP, 2 con nombre de paciente—. Un rollback que lo restaure convierte un problema
-- de disponibilidad en una exposición de datos reales. Si alguna vez hiciera falta
-- reabrir PUBLIC, tiene que ser una decisión aprobada y escrita, no el efecto lateral
-- de correr un archivo llamado "rollback".
--
-- CUÁNDO USARLO: si después de 0027 una pantalla falla con
-- `permission denied for function ...` con sesión iniciada. Esto le devuelve el
-- permiso a authenticated sin abrir nada a anon.
--
-- Idempotente. Se puede correr más de una vez.

-- ---------------------------------------------------------------------------
-- 1. Las 4 funciones que ANTES de 0027 dependían del EXECUTE de PUBLIC y no
--    tenían ningún grant explícito. Son las más críticas: las tres primeras las
--    evalúan las policies RLS con los privilegios del llamador, así que sin
--    EXECUTE para authenticated la aplicación entera deja de leer.
-- ---------------------------------------------------------------------------
grant execute on function can_write()                                                    to authenticated, service_role;
grant execute on function current_rol()                                                  to authenticated, service_role;
grant execute on function is_manager()                                                   to authenticated, service_role;
-- la llama case_subject_review_queue(), que NO es SECURITY DEFINER (corre como el
-- llamador): sin este grant, la cola de /calidad falla.
grant execute on function case_self_similarity(uuid)                                     to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Las RPC que ya tenían grant explícito a authenticated antes de 0027
--    (0005, 0008, 0016, 0018, 0020, 0023, 0024, 0025). Se repiten acá para que
--    este archivo alcance por sí solo, sin tener que re-correr migraciones viejas.
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
grant execute on function default_sales_owner()                                          to authenticated, service_role;
grant execute on function evaluate_automations()                                         to authenticated, service_role;
grant execute on function evento_roi()                                                   to authenticated, service_role;
grant execute on function purge_demo()                                                   to authenticated, service_role;
grant execute on function recompute_all()                                                to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Las que se quedan como están, a propósito.
--
--    recompute_doctor(uuid) y refresh_cohort_intervals(): solo service_role, igual
--    que antes de 0027 (0005 se las revocó a authenticated explícitamente).
--    log_audit(text,uuid,text,text,text): sin grant a nadie; solo la llaman
--    triggers y funciones SECURITY DEFINER, que corren como el dueño.
--    Las 15 funciones de trigger: sin grant. Postgres verifica EXECUTE al CREAR
--    el trigger, no al dispararlo, así que no hace falta y darlo sería exponerlas.
-- ---------------------------------------------------------------------------
grant execute on function recompute_doctor(uuid)                                         to service_role;
grant execute on function refresh_cohort_intervals()                                     to service_role;

-- ---------------------------------------------------------------------------
-- 4. Los privilegios por defecto siguen cerrados, a propósito.
--
--    0027 dejó `alter default privileges for role postgres in schema public
--    revoke execute on functions from public`. NO se deshace acá: deshacerlo hace
--    que toda función nueva vuelva a nacer ejecutable por anon, que es exactamente
--    la causa raíz de CRIT-01.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. Autoverificación: el rollback tampoco puede dejar nada abierto a anon.
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
    raise exception 'El rollback dejó % funciones SECURITY DEFINER ejecutables por anon: %', n, lista;
  end if;
  raise notice 'rollback 0027 OK: authenticated recuperó EXECUTE y anon sigue cerrado';
end $$;

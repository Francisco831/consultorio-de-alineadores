-- 0010: GRANTS explícitos por rol.
--
-- POR QUÉ EXISTE ESTE ARCHIVO. En este proyecto de Supabase una tabla nueva NACE
-- sin DML para los roles de la API: el ACL por defecto es solo {D,x,t,m}
-- (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) para anon, authenticated y service_role
-- — verificado el 20/8/2026 creando una tabla de prueba. Es el default seguro de
-- los proyectos nuevos, y significa que sin este archivo NADIE puede leer ni
-- escribir por PostgREST: los seeds fallan con "permission denied for table
-- companies" y la app ve la base vacía.
--
-- Los GRANTs y la RLS son ortogonales y hacen falta los dos: el grant habilita la
-- tabla, la policy decide QUÉ FILAS. La 0007 puso las policies; ésta pone los
-- permisos de tabla, y repite al final los revokes de la 0008 porque un grant
-- masivo posterior los habría pisado.

-- ---------- service_role: scripts, seeds y crons ----------
-- Es el rol de terminal/servidor; tiene BYPASSRLS, así que su alcance lo define
-- el guard de destino de los scripts, no la base.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------- authenticated: la app ----------
-- DML amplio; la RLS de la 0007 filtra por membresía de empresa.
grant select, insert, update on all tables in schema public to authenticated;

-- ---------- y ahora los recortes (mismo criterio que la 0008) ----------
-- Estructura: se administra por seed/script, no desde la app.
revoke insert, update on companies   from authenticated;
revoke insert, update on memberships from authenticated;
-- Corridas de sync/import: las escribe el service role.
revoke insert, update on sync_runs from authenticated;
-- Historial: lo escriben los triggers (security definer, corren como el owner);
-- append-only para todo lo que venga por la API.
revoke insert, update on audit_log from authenticated;
-- Líneas de extracto: las crea el importador (server action con sesión) y las
-- actualiza al conciliar, pero nunca se borran.
revoke delete on statement_lines from authenticated;

-- DELETE solo donde borrar es la operación correcta: desconciliar (se borra el
-- VÍNCULO, no la plata), limpiar sugerencias del matcher y editar catálogos
-- auxiliares. La plata (movements, accounts, categories, counterparties,
-- documents, import_batches) se anula con status, jamás se borra.
grant delete on reconciliations         to authenticated;
grant delete on match_suggestions       to authenticated;
grant delete on payment_method_aliases  to authenticated;
grant delete on import_templates        to authenticated;
grant delete on transfer_rules          to authenticated;

-- Vistas de la 0009 (security_invoker: la RLS del que consulta aplica adentro).
grant select on v_account_balances   to authenticated, service_role;
grant select on v_monthly_by_category to authenticated, service_role;
grant select on v_monthly_summary    to authenticated, service_role;

-- ---------- anon no toca nada ----------
-- La app entra siempre autenticada; anon solo existe para el handshake de login.
revoke all on all tables in schema public from anon;

-- ---------- que las tablas FUTURAS nazcan bien ----------
-- Sin esto, cada migración de la Etapa 2/3 repetiría el bug de arriba y el
-- síntoma (base "vacía" en la app) no se parece a su causa.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant select, insert, update on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to service_role;

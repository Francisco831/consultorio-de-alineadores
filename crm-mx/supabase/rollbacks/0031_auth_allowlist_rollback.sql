-- Rollback de 0031_auth_allowlist.sql.
--
-- QUÉ HACE: devuelve handle_new_user() a la versión de 0003 (sin el guard de
-- allowlist) y deja la tabla auth_allowlist EN PIE, con sus datos.
--
-- POR QUÉ NO BORRA LA TABLA. Borrarla no aporta nada y sí saca información: la
-- lista de quién fue invitado, por quién y cuándo, más el rastro en audit_log. Con
-- el guard retirado la tabla queda inerte —nadie la consulta— así que conservarla
-- no tiene costo y permite volver a aplicar 0031 sin re-sembrar. Si además se
-- quiere borrarla, está el bloque comentado al final; leer antes la advertencia.
--
-- QUÉ SE REABRE: el alta pública vuelve a depender ÚNICAMENTE del toggle
-- disable_signup del panel de Supabase. Si ese toggle está encendido, cualquiera
-- puede crear una cuenta, y la policy de lectura `using (true)` le da 18 de 26
-- tablas — 59.028 filas con datos de doctores y pacientes. O sea: correr este
-- rollback con el signup abierto expone la base entera.
--
-- ANTES DE CORRERLO, verificar que el signup esté cerrado:
--   npm run test:seguridad   → chequeo 3 tiene que decir disable_signup = true
--
-- CUÁNDO SÍ correrlo: si el guard estuviera impidiendo un alta legítima y hubiera
-- que destrabarla ya. La alternativa sana y casi siempre mejor es agregar el mail
-- a la allowlist, que es un INSERT y no toca la seguridad de nadie más:
--   insert into auth_allowlist (email, note) values ('quien@sea.com', 'motivo');

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rol user_role;
begin
  -- rol SOLO desde app_metadata (lo setea el admin API / server; el cliente NO puede
  -- setearlo en signup). user_metadata es controlado por el cliente => nunca autoriza.
  v_rol := (case new.raw_app_meta_data->>'rol'
    when 'ADMIN'           then 'ADMIN'
    when 'COUNTRY_MANAGER' then 'COUNTRY_MANAGER'
    when 'SALES_MANAGER'   then 'SALES_MANAGER'
    when 'SALES'           then 'SALES'
    when 'CLINICAL'        then 'CLINICAL'
    else 'VIEWER'
  end)::user_role;

  insert into profiles (id, nombre, rol)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    v_rol
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- Verificación: que el guard efectivamente ya no esté.
do $$
begin
  if position('auth_allowlist' in pg_get_functiondef('handle_new_user()'::regprocedure)) > 0 then
    raise exception 'El rollback no quitó el guard de handle_new_user';
  end if;
  raise notice 'Rollback 0031 OK: handle_new_user sin guard. La tabla auth_allowlist queda en pie.';
end $$;

-- ---------------------------------------------------------------------------
-- OPCIONAL — borrar también la tabla
-- ---------------------------------------------------------------------------
-- Descomentar solo si se decidió que la allowlist no va a volver. Se pierde el
-- registro de invitaciones; el rastro en audit_log sobrevive pero apuntando a ids
-- de filas que ya no existen.
--
-- drop trigger if exists auth_allowlist_audit_trg on auth_allowlist;
-- drop function if exists auth_allowlist_audit();
-- drop table if exists auth_allowlist;

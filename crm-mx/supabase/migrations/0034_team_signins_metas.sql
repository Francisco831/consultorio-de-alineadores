-- 0034 — Actividad del equipo: cuándo entró cada uno al CRM.
--
-- El pedido de Pancho (19/8): "ver cuándo entró Rocío y Juan" desde un panel
-- de administrador. El dato vive en auth.users.last_sign_in_at, que la app no
-- puede leer (el schema auth no se expone por PostgREST). Esta función lo
-- puentea con SECURITY DEFINER y gate de rol adentro: solo los roles de
-- gestión ven los ingresos del equipo — para cualquier otro rol la función
-- levanta excepción (mismo trío que usa /ajustes).

create or replace function team_signins()
returns table (
  user_id uuid,
  last_sign_in_at timestamptz,
  cuenta_creada timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if (select rol from profiles where id = auth.uid())::text
     not in ('ADMIN','COUNTRY_MANAGER','SALES_MANAGER') then
    raise exception 'Solo roles de gestión pueden ver la actividad del equipo';
  end if;
  return query
    select u.id, u.last_sign_in_at, u.created_at
    from auth.users u
    join profiles p on p.id = u.id;
end;
$$;

revoke execute on function team_signins() from public, anon;
grant execute on function team_signins() to authenticated;

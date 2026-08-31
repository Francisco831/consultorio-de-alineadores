-- Vuelve team_signins() al comportamiento de 0034 (solo el login de auth)
-- y borra la marca de entrada propia.

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

drop function if exists touch_last_seen();

alter table profiles drop column if exists last_seen_at;

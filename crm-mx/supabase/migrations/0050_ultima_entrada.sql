-- 0050 — Última entrada real al CRM (fix del cuadro "Ingresos al CRM").
--
-- El bug (Pancho 31/8): el cuadro mostraba auth.users.last_sign_in_at, que
-- solo se mueve cuando alguien vuelve a INICIAR sesión con contraseña. Con la
-- sesión guardada en el navegador, entrar todos los días no lo toca: Rocío
-- entró y cargó actividad y el cuadro la daba por ausente desde el 22/8.
--
-- El fix: la app marca la entrada real en profiles.last_seen_at — el layout
-- llama touch_last_seen() en cada carga de página, con freno de 5 minutos
-- adentro de la función para no escribir en cada request — y team_signins()
-- pasa a devolver lo más nuevo entre el login y esa marca. La firma de
-- team_signins() no cambia, así el panel viejo y el nuevo conviven durante
-- el deploy.

alter table profiles add column if not exists last_seen_at timestamptz;

create or replace function touch_last_seen()
returns void
language sql
security definer
set search_path = public
as $$
  update profiles
  set last_seen_at = now()
  where id = auth.uid()
    and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
$$;

revoke execute on function touch_last_seen() from public, anon;
grant execute on function touch_last_seen() to authenticated;

-- Misma firma que en 0034; last_sign_in_at pasa a ser la última ENTRADA.
-- greatest() ignora nulls: si solo existe uno de los dos datos, vale ese.
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
    select u.id, greatest(u.last_sign_in_at, p.last_seen_at), u.created_at
    from auth.users u
    join profiles p on p.id = u.id;
end;
$$;

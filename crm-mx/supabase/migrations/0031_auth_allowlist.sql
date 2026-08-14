-- 0031: allowlist de altas — el respaldo EN CÓDIGO del toggle de signup (R-3).
--
-- QUÉ CIERRA. Hoy nadie puede crear una cuenta desde afuera porque `disable_signup`
-- está en true. Eso es un toggle del panel de Supabase: una casilla que alguien
-- puede volver a marcar sin dejar rastro en el repositorio. Y del otro lado la
-- policy de lectura es `using (true)`, así que UNA cuenta cualquiera lee 18 de las
-- 26 tablas — 59.028 filas, incluidos los 7.034 doctores, los 1.046 pagos y los
-- nombres de paciente (chequeo 8 de security-checks).
--
-- Con esta migración, aunque el toggle se encienda, un alta que no esté invitada
-- no llega a existir: el trigger aborta la transacción del alta.
--
-- ESTO NO REEMPLAZA AL TOGGLE. Son los dos, no uno. El toggle es el control
-- principal; esto es la red abajo.
--
-- EL HECHO QUE ORDENA EL DISEÑO (PLAN_REMEDIACION_CRM.md §8.2): on_auth_user_created
-- es AFTER INSERT sobre auth.users (0003:61-63) y corre en la misma transacción que
-- el alta. De ahí salen las dos propiedades que hacen seguro este cambio:
--   * un `raise exception` adentro aborta el alta completa — el guard sirve;
--   * el trigger SOLO corre al crear un usuario, nunca después. Por lo tanto sacar
--     un mail de la allowlist NO puede echar a nadie ni invalidar ninguna sesión.
--
-- DOS AJUSTES respecto del diseño escrito en el plan, los dos forzados por el schema:
--   1. El plan proponía `email citext primary key`. La extensión citext no está
--      habilitada (0001 solo habilita pg_trgm) y habilitarla para esto es traer una
--      dependencia por una comparación. Se usa `text` + índice único sobre
--      lower(email), que da la misma insensibilidad a mayúsculas.
--   2. Se agrega `id uuid`. audit_log.entity_id es uuid NOT NULL, así que sin un id
--      propio la tabla no se puede auditar con log_audit(), que es justamente uno de
--      los requisitos del diseño.
--
-- MODO: excepción desde el día uno, no el despliegue en dos tiempos que preveía el
-- plan. El motivo del modo aviso era "no romper el alta de usuarios el primer día", y
-- ese riesgo acá no existe: los usuarios actuales se siembran en ESTA misma
-- transacción desde auth.users, y como el trigger no vuelve a correr para ellos, no
-- hay forma de dejar afuera a nadie que ya exista. El único camino de alta nueva es
-- una invitación deliberada, que falla con un mensaje explícito y se arregla
-- agregando el mail. En modo aviso el agujero seguiría abierto en producción, que es
-- exactamente lo que esta migración viene a cerrar.
--
-- Idempotente: if not exists / or replace / seed con NOT EXISTS.

-- ---------------------------------------------------------------------------
-- 1. La tabla
-- ---------------------------------------------------------------------------

create table if not exists auth_allowlist (
  id         uuid primary key default gen_random_uuid(),
  -- se guarda SIEMPRE normalizado (minúsculas, sin espacios): lo fuerza el trigger
  -- de abajo. Así el unique alcanza para que 'A@x.com', 'a@x.com' y 'a@x.com ' sean
  -- la misma fila, y on_conflict puede apuntarle (un índice sobre lower(email) no
  -- se puede targetear desde PostgREST).
  email      text not null unique,
  -- baja LÓGICA: quitar a alguien se revierte poniendo active = true, y queda
  -- quién y cuándo. Un delete físico también está permitido y se audita.
  active     boolean not null default true,
  added_by   uuid references profiles(id),
  added_at   timestamptz not null default now(),
  removed_by uuid references profiles(id),
  removed_at timestamptz,
  note       text
);

-- Normalización en la base y no en cada llamador: un mail pegado desde un cliente
-- de correo trae mayúsculas o un espacio al final, y sin esto entraba como fila
-- distinta que además no matchea contra el alta.
create or replace function auth_allowlist_normalize() returns trigger
language plpgsql set search_path = public as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end $$;

drop trigger if exists auth_allowlist_normalize_trg on auth_allowlist;
create trigger auth_allowlist_normalize_trg
  before insert or update on auth_allowlist
  for each row execute function auth_allowlist_normalize();

comment on table auth_allowlist is
  'Mails autorizados a tener cuenta. Lo verifica handle_new_user() al crear el '
  'usuario en auth.users. Es el respaldo en código del toggle disable_signup, no '
  'su reemplazo. Sacar un mail NO echa a nadie: el trigger es AFTER INSERT.';

-- ---------------------------------------------------------------------------
-- 2. Siembra desde auth.users — imposible dejar afuera a quien ya existe
-- ---------------------------------------------------------------------------
-- Se siembra desde la propia tabla de usuarios y no desde una lista escrita a mano,
-- que es donde se cometería el error de olvidarse de alguien. Corre ANTES de crear
-- el guard, en la misma transacción.

insert into auth_allowlist (email, note)
select distinct on (lower(btrim(u.email)))
       u.email, 'sembrado al crear la allowlist (0031)'
from auth.users u
where u.email is not null
  and not exists (
    select 1 from auth_allowlist a where a.email = lower(btrim(u.email))
  )
-- distinct on: dos usuarios con el mismo mail en distinta capitalización colisionarían
-- contra el unique y abortarían la migración entera
order by lower(btrim(u.email)), u.created_at;

-- ---------------------------------------------------------------------------
-- 3. RLS: solo el manager, también para leer
-- ---------------------------------------------------------------------------
-- La lectura NO es `using (true)` como el resto de las tablas, y es a propósito:
--   * la lista de quién está invitado no le sirve a nadie salvo a quien administra
--     usuarios, y es exactamente el dato que le dice a un atacante a qué mails
--     apuntar. Sería la primera tabla de `public` que publica mails del equipo;
--   * el chequeo 8 de security-checks cuenta al vuelo las tablas legibles por una
--     cuenta cualquiera (hoy 18 de 26, 59.028 filas). Dejarla abierta haría que la
--     migración que existe para poder bajar ese número lo suba a 19 de 27 el mismo
--     día que se aplica.

alter table auth_allowlist enable row level security;

drop policy if exists auth_allowlist_select on auth_allowlist;
create policy auth_allowlist_select on auth_allowlist
  for select to authenticated using (is_manager());

drop policy if exists auth_allowlist_write on auth_allowlist;
create policy auth_allowlist_write on auth_allowlist
  for all to authenticated using (is_manager()) with check (is_manager());

-- ---------------------------------------------------------------------------
-- 4. Auditoría de la lista
-- ---------------------------------------------------------------------------
-- Quién invitó a quién y quién sacó a quién. Es además el primer caso donde se
-- registran los DELETE, que hasta ahora no dejaban rastro en ningún lado.

create or replace function auth_allowlist_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform log_audit('auth_allowlist', new.id, 'email', null, new.email);
  elsif tg_op = 'UPDATE' then
    if new.active is distinct from old.active then
      perform log_audit('auth_allowlist', new.id, 'active',
                        old.active::text, new.active::text);
    end if;
    if lower(new.email) is distinct from lower(old.email) then
      perform log_audit('auth_allowlist', new.id, 'email', old.email, new.email);
    end if;
  else
    perform log_audit('auth_allowlist', old.id, 'email', old.email, null);
  end if;
  return null;  -- AFTER trigger: el valor de retorno se ignora
end $$;

drop trigger if exists auth_allowlist_audit_trg on auth_allowlist;
create trigger auth_allowlist_audit_trg
  after insert or update or delete on auth_allowlist
  for each row execute function auth_allowlist_audit();

-- ---------------------------------------------------------------------------
-- 5. El guard, dentro de handle_new_user
-- ---------------------------------------------------------------------------
-- Se reescribe la función entera (no hay forma de "insertar una línea") conservando
-- exactamente la lógica de rol de 0003: el rol sale SOLO de app_metadata, que el
-- cliente no puede escribir en un signup, y una metadata malformada cae a VIEWER en
-- vez de abortar el alta con un cast fallido.

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rol user_role;
begin
  -- ---- allowlist: antes que nada ----
  -- Un alta sin mail no tiene forma de estar invitada. Ningún camino de esta
  -- aplicación crea usuarios sin mail (create-users.ts siempre lo manda), así que
  -- rechazar es lo correcto y no rompe nada existente.
  if new.email is null then
    raise exception 'Alta no autorizada: el usuario no tiene email';
  end if;
  -- ESCAPE DE ARRANQUE. Si la allowlist está VACÍA, el guard no bloquea.
  --
  -- Sin esto la migración es una trampa: en una base nueva —o en una restauración
  -- lógica, donde auth.users se repuebla fila por fila— la siembra no encuentra
  -- usuarios, la lista queda vacía, y entonces NADIE puede crear el primer usuario.
  -- Nunca. Ni con service-role, porque create-users.ts también dispara este trigger.
  -- El sistema quedaría cerrado contra sí mismo y solo se abriría con SQL a mano.
  --
  -- Que la lista vacía deje pasar no debilita nada real: una allowlist vacía no
  -- expresa "no autorizo a nadie", expresa "todavía no se configuró". Quien decide
  -- en ese estado sigue siendo `disable_signup`, que es el control principal. Apenas
  -- entra el primer mail, el guard pasa a ser estricto y ya no se relaja nunca.
  if exists (select 1 from auth_allowlist where active) then
    if not exists (
      select 1 from auth_allowlist a
      where a.email = lower(btrim(new.email)) and a.active
    ) then
      raise exception
        'Alta no autorizada: % no está en la lista de invitaciones. '
        'Un ADMIN tiene que agregarlo en auth_allowlist antes de invitarlo.', new.email
        using hint = 'insert into auth_allowlist (email, note) values (''' || new.email || ''', ''motivo'');';
    end if;
  else
    raise warning
      'auth_allowlist está vacía: se permite el alta de % sin verificar. '
      'Cargá la lista para que el guard empiece a aplicar.', new.email;
  end if;

  -- ---- rol: idéntico a 0003 ----
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

-- ---------------------------------------------------------------------------
-- 6. Autoverificación — aborta la migración si algo quedó a medias
-- ---------------------------------------------------------------------------
-- Lo que se comprueba es lo que haría daño: que haya quedado algún usuario real
-- fuera de la lista. Si eso pasara, la migración se revierte entera y nadie pierde
-- el acceso. El comportamiento del guard (rechaza ajenos, acepta invitados) lo
-- prueba el chequeo 4 de scripts/security-checks.ts con altas reales en
-- transacciones revertidas: acá adentro no se puede, porque insertar en auth.users
-- dentro de la propia migración ensuciaría la tabla si algo saliera distinto.
do $$
declare
  v_afuera int;
  v_total  int;
begin
  select count(*) into v_afuera
  from auth.users u
  where u.email is not null
    and not exists (
      select 1 from auth_allowlist a
      where a.email = lower(btrim(u.email)) and a.active
    );
  if v_afuera > 0 then
    raise exception
      '0031 ABORTA: % usuario(s) existentes quedarían fuera de la allowlist', v_afuera;
  end if;

  select count(*) into v_total from auth_allowlist where active;
  raise notice '0031 OK: % mail(s) en la allowlist, 0 usuarios existentes afuera', v_total;

  if position('auth_allowlist' in pg_get_functiondef('handle_new_user()'::regprocedure)) = 0 then
    raise exception '0031 ABORTA: handle_new_user no quedó con el guard de allowlist';
  end if;

  -- La función con el guard adentro no vale nada si el trigger que la invoca no
  -- existe o está deshabilitado. Sin esto la migración podía terminar en verde con
  -- el guard inerte — la peor forma de fallar, porque deja creyendo que hay una
  -- protección donde no hay ninguna. tgenabled = 'D' es deshabilitado.
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'on_auth_user_created'
      and n.nspname = 'auth' and c.relname = 'users'
      and t.tgenabled <> 'D'
  ) then
    raise exception
      '0031 ABORTA: el trigger on_auth_user_created no existe o está deshabilitado, '
      'así que el guard nunca correría';
  end if;

  -- Los usuarios sin mail quedan fuera de la siembra POR CONSTRUCCIÓN (el where la
  -- filtra), así que el conteo de arriba no los mira. Se los cuenta aparte para que
  -- dejarlos afuera sea una decisión visible y no un efecto lateral del WHERE.
  select count(*) into v_afuera from auth.users where email is null;
  if v_afuera > 0 then
    raise notice
      '0031 AVISO: % usuario(s) sin email. Siguen entrando (el trigger no vuelve a '
      'correr para ellos), pero de acá en más no se pueden crear usuarios sin mail', v_afuera;
  end if;
end $$;

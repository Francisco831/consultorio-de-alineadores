-- 0061 — Lo que se anota se puede buscar, y una tarea se puede pasar de mano.
--
-- Pedido del grupo México KS (Pancho, Juan y Rocío, 11-14/9): (1) comentarios
-- por doctor "buscables/filtrables por palabra clave" para armar listas como
-- "los que van al Summit"; (2) que una tarea cargada por uno le aparezca al otro.
--
-- Lo que encontramos antes de tocar nada:
--   · Los comentarios con fecha y autor YA existen: son las actividades
--     (activities.summary/outcome + created_by + occurred_at, editables por su
--     autor desde 0051) y la libreta compartida doctors.observaciones (0048).
--     Lo que no existía era buscar adentro: el buscador global solo miraba
--     nombre, mail y teléfono. "Summit" estaba en 21 actividades, 5
--     observaciones y 18 tareas y no había forma de juntarlas.
--   · Para LISTAS el texto libre es la herramienta equivocada (buscar "summit"
--     trae igual al que dijo "voy" y al que dijo "no voy"). Para eso están las
--     etiquetas (doctors.tags), que ya filtran en /doctores pero que ninguna
--     pantalla dejaba poner. Ahora se cargan desde la ficha.
--   · Las tareas de Juan sobre Mejía Colin estaban a su nombre y pendientes:
--     no había ningún bloqueo por owner. Lo que faltaba era poder crear una
--     tarea PARA otro y pasarse una de mano, cosa que la base ya permitía
--     (tasks_guard, 0052) pero ninguna pantalla ofrecía.
--
-- Esta migración pone lo que la app nueva necesita de la base:
--   1. tags_en_uso(): qué etiquetas hay y cuántos doctores tienen cada una,
--      para el selector del filtro y las sugerencias de la ficha. Sin esto la
--      página tendría que bajar los 7.176 arrays de tags para armar la lista.
--   2. Formato de las etiquetas, chequeado en la base: minúsculas, números,
--      ':' '.' '_' '-', máx 60. Las 83 etiquetas que hay hoy ya cumplen; el
--      check está para que un script o un PATCH directo no meta "Summit 2026"
--      con mayúscula y espacio, que después no matchea con "summit-2026".
--   3. Cambiar de dueño una tarea queda auditado (tasks_audit solo miraba
--      status). "De quién es" es lo que cuentan /equipo y la alarma de las
--      17:30: si se mueve sin rastro, esos números no se pueden explicar.
--   4. Índices trigram para el buscador de notas (pg_trgm está desde 0001).
--      Con 5.332 actividades hoy no hacen falta; están para que el buscador
--      no se vuelva lento cuando sean 50.000.
--
-- Rollback: supabase/rollbacks/0061_lo_que_se_anota_se_busca_y_la_tarea_cambia_de_mano_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Etiquetas en uso
-- ---------------------------------------------------------------------------
-- p_acreditados: true = solo la cartera acreditada (/doctores), false = solo
-- los que están por acreditarse (/prospeccion/lista), null = todos (la ficha).
-- Es SECURITY INVOKER a propósito: lee doctors con la RLS del que llama, que
-- para authenticated es select libre (0004). No expone nada nuevo.

create or replace function tags_en_uso(p_acreditados boolean default null)
returns table (tag text, n bigint)
language sql stable set search_path = public as $$
  select t.tag, count(*)::bigint as n
  from doctors d
  cross join lateral unnest(d.tags) as t(tag)
  where not d.is_demo
    and (p_acreditados is null or d.is_accredited = p_acreditados)
  group by t.tag
  order by n desc, t.tag
$$;

comment on function tags_en_uso(boolean) is
  'Etiquetas (doctors.tags) con cuántos doctores tiene cada una. p_acreditados filtra por área; null = todas. Alimenta el filtro por etiqueta de las listas y las sugerencias de la ficha.';

revoke all on function tags_en_uso(boolean) from public, anon;
grant execute on function tags_en_uso(boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Formato de las etiquetas
-- ---------------------------------------------------------------------------
-- La app normaliza antes de guardar (lib/etiquetas.ts); esto es el cinturón
-- para lo que no pasa por la app.

create or replace function etiquetas_validas(p_tags text[])
returns boolean
language sql immutable as $$
  select coalesce(bool_and(t ~ '^[a-z0-9][a-z0-9:._-]{0,59}$'), true)
  from unnest(p_tags) as t
$$;

-- El check se evalúa con los permisos del que escribe la fila: sin este grant
-- un UPDATE de la sesión fallaría con "permission denied for function".
revoke all on function etiquetas_validas(text[]) from public, anon;
grant execute on function etiquetas_validas(text[]) to authenticated, service_role;

alter table doctors drop constraint if exists doctors_tags_formato;
alter table doctors add constraint doctors_tags_formato
  check (etiquetas_validas(tags));

-- ---------------------------------------------------------------------------
-- 3. Cambiar de dueño una tarea deja rastro
-- ---------------------------------------------------------------------------
-- create or replace conserva los privilegios que 0027 dejó; el revoke se
-- repite igual por la convención de 0051 (que no dependa de eso).

create or replace function tasks_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    perform log_audit('task', new.id, 'status', old.status::text, new.status::text);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform log_audit('task', new.id, 'assigned_to', old.assigned_to::text, new.assigned_to::text);
  end if;
  return new;
end $$;

revoke all on function tasks_audit() from public, anon;

-- ---------------------------------------------------------------------------
-- 4. Índices del buscador de notas
-- ---------------------------------------------------------------------------

create index if not exists activities_summary_trgm_idx
  on activities using gin (summary gin_trgm_ops);
create index if not exists activities_outcome_trgm_idx
  on activities using gin (outcome gin_trgm_ops);
create index if not exists doctors_observaciones_trgm_idx
  on doctors using gin (observaciones gin_trgm_ops);
create index if not exists tasks_title_trgm_idx
  on tasks using gin (title gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 5. Verificación
-- ---------------------------------------------------------------------------

do $$
declare
  n_tags integer;
begin
  if not exists (select 1 from pg_proc where proname = 'tags_en_uso') then
    raise exception '0061: tags_en_uso() no quedó creada';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'doctors_tags_formato'
  ) then
    raise exception '0061: el check de formato de etiquetas no quedó montado';
  end if;
  -- el check tiene que haber validado lo que ya había: si alguna etiqueta
  -- existente no cumpliera, el alter de arriba habría fallado; esto lo deja dicho
  select count(*) into n_tags from tags_en_uso(null);
  if n_tags = 0 then
    raise exception '0061: tags_en_uso() devolvió 0 etiquetas y la base tiene miles cargadas';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'activities_summary_trgm_idx') then
    raise exception '0061: falta el índice trigram de activities.summary';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'tasks_title_trgm_idx') then
    raise exception '0061: falta el índice trigram de tasks.title';
  end if;
  -- lo mismo que mira el chequeo 1 de scripts/security-checks.ts
  if exists (
    select 1 from pg_proc p
     where p.proname in ('tags_en_uso', 'etiquetas_validas', 'tasks_audit')
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception '0061: alguna función nueva quedó ejecutable por anon';
  end if;
  raise notice '0061 OK: % etiquetas en uso, formato chequeado, reasignación auditada, índices del buscador puestos.', n_tags;
end $$;

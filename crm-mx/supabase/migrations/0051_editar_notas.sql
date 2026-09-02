-- 0051 — Lo que ya se escribió se puede corregir.
--
-- Pedido de Pancho el 31/8: "necesito en el CRM poder modificar las notas, por
-- ejemplo Rocío subió una y la quiere modificar". Con dos reglas que eligió él:
-- la corrige QUIEN LA ESCRIBIÓ y nadie más, y no se borra — se corrige.
--
-- De las cuatro libretas del CRM, tres eran de una sola escritura:
--   · la actividad de la ficha (activities.summary/outcome). Es la que duele:
--     es lo que Rocío carga todos los días y lo que se lee en el registro día
--     por día del equipo. Hasta hoy un typo se "arreglaba" cargando otra
--     actividad encima, que duplica la fila en el timeline y en los conteos.
--   · las notas de un evento (events.notas): para corregirlas había que borrar
--     el evento y recrearlo, y eso se lleva puesta la lista de asistentes.
--   · los pendientes de /hoy: la base ya los cubre (policy `user_id = auth.uid()`
--     de 0039), así que ahí no hace falta nada acá — solo la pantalla.
-- La cuarta, doctors.observaciones (0048), ya se edita y es de todos a
-- propósito: es la libreta compartida del doctor, no la nota de una persona.
--
-- POR QUÉ NO ALCANZABA CON LO QUE YA ESTABA:
--   · `activities_update` (0004) ya dejaba escribir a cualquier no-VIEWER, pero
--     sin UI: la policy estaba abierta y el producto no la usaba. Abrirla en la
--     pantalla sin cerrarla en la base significaba que cualquiera reescribiera
--     el registro de otro, y encima pudiera mover `doctor_id`, `type`,
--     `occurred_at`, `created_by` o `is_demo` (que hace que `purge_demo()` la
--     borre) — todos números de desempeño de una persona.
--   · `activities_engagement_guard` (0024/0029) es lista negra de 3 columnas:
--     no protege nada de eso. Acá se agrega el guard de lista blanca que 0030
--     impuso para `alerts` y `ai_recommendations` y que `activities` nunca tuvo.
--   · `events_update` (0035) estaba abierta a cualquier no-VIEWER y no la usaba
--     nadie. Se cierra al autor antes de darle pantalla.
--
-- Rollback: supabase/rollbacks/0051_editar_notas_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Rastro de la corrección
-- ---------------------------------------------------------------------------
-- Las escribe la base, no la app: el cliente no puede falsear quién corrigió.

alter table activities add column if not exists edited_at timestamptz;
alter table activities add column if not exists edited_by uuid references profiles(id);

comment on column activities.edited_at is
  'Cuándo se corrigió el texto de esta actividad. La estampa el trigger activities_edicion_guard, nunca la app. Null = nunca se tocó desde que se cargó.';

-- ---------------------------------------------------------------------------
-- 2. sync_key — para que corregir el texto no genere un duplicado
-- ---------------------------------------------------------------------------
-- El cron de actividades deduplica con `doctor_id|día UTC|summary[:80]`
-- (lib/actividades-sync.ts), calculado sobre el summary ACTUAL. O sea: si Rocío
-- corrige el texto de una actividad que vino del intranet, la corrida siguiente
-- no la reconoce y la vuelve a insertar. Ese fallo ya pasó por otra vía —×4
-- copias de 13 contact points, 20/8—, así que la clave se congela al nacer y
-- deja de depender de un texto que ahora es editable.

alter table activities add column if not exists sync_key text;

comment on column activities.sync_key is
  'Huella con la que el cron de actividades reconoce lo que ya trajo: doctor|día UTC|summary[:80] CONGELADO al insertar. No sigue al summary a propósito: si lo siguiera, corregir una nota importada la duplicaría en la próxima corrida.';

-- El backfill toca todas las filas: sin desactivar los triggers dispara un
-- recompute_doctor() por actividad (activities_recompute_trg es AFTER UPDATE) y
-- la migración no termina más.
alter table activities disable trigger activities_recompute_trg;
alter table activities disable trigger activities_updated_at;

update activities
   set sync_key = doctor_id::text || '|'
               || to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD') || '|'
               || left(coalesce(summary, ''), 80)
 where sync_key is null;

alter table activities enable trigger activities_recompute_trg;
alter table activities enable trigger activities_updated_at;

create or replace function activities_set_sync_key() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- el cron la manda calculada desde TS (misma fórmula, sin sorpresas de
  -- unicode); todo lo demás —la app, las tareas, la acreditación, la IA— entra
  -- sin ella y la calcula acá.
  --
  -- `not is_system()` la recalcula SIEMPRE que la mande una sesión de usuario:
  -- es la huella con la que el cron decide qué ya trajo, así que una sesión que
  -- pudiera elegirla haría que el cron saltee un contact point real creyéndolo
  -- duplicado. El cron corre con service-role, o sea is_system().
  if new.sync_key is null or not is_system() then
    new.sync_key := new.doctor_id::text || '|'
                 || to_char(new.occurred_at at time zone 'UTC', 'YYYY-MM-DD') || '|'
                 || left(coalesce(new.summary, ''), 80);
  end if;
  return new;
end $$;

drop trigger if exists activities_sync_key_trg on activities;
create trigger activities_sync_key_trg
  before insert on activities
  for each row execute function activities_set_sync_key();

-- ---------------------------------------------------------------------------
-- 3. Guard de edición: qué columnas, y de quién
-- ---------------------------------------------------------------------------
-- Lista blanca con diff jsonb, el patrón que 0030 dejó como estándar: toda
-- columna que se agregue en el futuro nace protegida.
--
-- `main_topic`, `next_action` y las cuatro de engagement quedan editables
-- porque son las que escribe /calidad (lib/actions/quality.ts) y la aceptación
-- de una recomendación de la IA (lib/actions/ai.ts) — esas SÍ se hacen sobre
-- actividades ajenas y no se rompen: el candado de autor es solo para el texto.

create or replace function activities_edicion_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  editable text[] := array[
    -- el texto de la nota: lo que esta migración viene a abrir
    'summary', 'outcome',
    -- clasificación de calidad (0022/0024/0029) — la hace otra persona a propósito
    'engagement_quality', 'engagement_source', 'engagement_set_by', 'engagement_set_at',
    'main_topic', 'next_action',
    -- `updated_at` lo pisa set_updated_at() después de este trigger
    'updated_at'
  ];
  cambio_texto boolean := new.summary is distinct from old.summary
                       or new.outcome is distinct from old.outcome;
begin
  if is_system() then return new; end if;

  -- El rastro de la corrección NO se acepta del cliente: se descarta lo que
  -- venga y se estampa abajo. Si estuviera en la lista blanca, un PATCH directo
  -- a PostgREST que no tocara el texto ni siquiera llegaría al candado de autor
  -- —el diff no lo vería— y podría borrar el "editado" de una nota propia o
  -- imputarle una corrección a otra persona. Mismo criterio que `engagement_set_by`
  -- en 0029:104.
  new.edited_at := old.edited_at;
  new.edited_by := old.edited_by;

  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception 'De una actividad registrada solo se corrige el texto: la fecha, el tipo y el doctor quedan como se cargaron';
  end if;

  if cambio_texto then
    -- decisión de Pancho (31/8): la corrige quien la escribió. Las que trajo el
    -- sync sin autor (created_by null) no las corrige nadie: no las escribió
    -- una persona.
    if old.created_by is distinct from auth.uid() then
      raise exception 'Esta nota la escribió otra persona: solo quien la cargó puede corregirla';
    end if;
    new.edited_at := now();
    new.edited_by := auth.uid();
  end if;

  return new;
end $$;

drop trigger if exists activities_edicion_guard_trg on activities;
create trigger activities_edicion_guard_trg
  before update on activities
  for each row execute function activities_edicion_guard();

-- ---------------------------------------------------------------------------
-- 4. Auditoría del texto
-- ---------------------------------------------------------------------------
-- Es lo único que permite saber qué decía antes: `activities` no tenía ningún
-- trigger de audit. Si el registro día por día se puede reescribir, tiene que
-- quedar el texto viejo en algún lado. Molde: doctors_audit (0003/0015).
-- log_audit() no está grantada a `authenticated` a propósito (0027): auditar
-- es siempre por trigger, nunca desde una server action.

create or replace function activities_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.summary is distinct from old.summary then
    perform log_audit('activity', new.id, 'summary', old.summary, new.summary);
  end if;
  if new.outcome is distinct from old.outcome then
    perform log_audit('activity', new.id, 'outcome', old.outcome, new.outcome);
  end if;
  return null;
end $$;

drop trigger if exists activities_audit_trg on activities;
create trigger activities_audit_trg
  after update on activities
  for each row execute function activities_audit();

-- ---------------------------------------------------------------------------
-- 5. Corregir el texto no recalcula nada
-- ---------------------------------------------------------------------------
-- `activities_recompute_trg` (0005:433) es AFTER INSERT OR UPDATE OR DELETE, así
-- que cada corrección de una coma dispara `recompute_doctor()`. Eso no es una
-- ineficiencia: recompute escribe `lifecycle_stage` y `activation_stage` con
-- reglas de calendario (0019:308-333, "hace más de 365 días del último caso
-- nuevo"), y `doctors_audit` las audita con `actor_id = auth.uid()`. O sea que
-- Rocío corrigiendo un typo podía terminar FIRMANDO que un doctor pasó a
-- perdido, y sumando esa fila a su registro del día.
--
-- De `activities`, recompute lee exactamente tres columnas: `doctor_id`,
-- `occurred_at` y `type` (0019:95, :102-105, :114). Ni summary ni outcome. Así
-- que el UPDATE solo recalcula si cambió alguna de esas tres —cosa que el guard
-- de arriba ya no permite desde una sesión, o sea que en la práctica queda para
-- los scripts de service-role que reasignan doctor_id (merge-prospect-dups).
-- INSERT y DELETE siguen recalculando siempre, como hasta hoy.

drop trigger if exists activities_recompute_trg on activities;

create trigger activities_recompute_trg
  after insert or delete on activities
  for each row execute function recompute_doctor_trigger();

create trigger activities_recompute_upd_trg
  after update on activities
  for each row
  when (old.doctor_id  is distinct from new.doctor_id
     or old.occurred_at is distinct from new.occurred_at
     or old.type       is distinct from new.type)
  execute function recompute_doctor_trigger();

-- ---------------------------------------------------------------------------
-- 6. events: la nota del evento la corrige quien lo cargó
-- ---------------------------------------------------------------------------
-- La policy de 0035 dejaba a cualquier no-VIEWER actualizar cualquier evento;
-- como no había pantalla, nunca se ejerció. Antes de dársela, se cierra a la
-- misma regla que el resto: el autor. Un evento sin created_by (importado) no
-- lo edita nadie.

drop policy if exists events_update on events;
create policy events_update on events for update to authenticated
  using (created_by = auth.uid() and can_write())
  with check (created_by = auth.uid() and can_write());

-- Y el alcance —SOLO las notas— con el mismo guard de lista blanca, porque si
-- vive solo en la server action no existe: por PostgREST el autor podría mover
-- `created_at`, que es la columna con la que /panel y /equipo/actividad cuentan
-- los eventos del período. O sea, subirse el propio número cambiando de mes un
-- evento viejo. Título, fecha, tipo, dictante y modalidad quedan como se
-- cargaron: para eso está borrar y volver a cargar.
create or replace function events_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  editable text[] := array['notas'];
begin
  if is_system() then return new; end if;
  if (to_jsonb(new) - editable) is distinct from (to_jsonb(old) - editable) then
    raise exception 'De un evento ya registrado solo se corrigen las notas';
  end if;
  return new;
end $$;

drop trigger if exists events_guard_trg on events;
create trigger events_guard_trg
  before update on events
  for each row execute function events_guard();

-- ---------------------------------------------------------------------------
-- 7. Los grants de las funciones nuevas
-- ---------------------------------------------------------------------------
-- Una función nace con EXECUTE para PUBLIC, y `anon` hereda de PUBLIC. Como son
-- `security definer`, el chequeo 1 de scripts/security-checks.ts las cuenta y
-- pasa a FALLA. Ya pasó exactamente eso el 18/8 y costó una migración entera
-- (0033_revoke_allowlist_audit.sql). Convención: 0027_function_grants.sql.
-- Ninguna es invocable por RPC igual (devuelven `trigger`), pero el gate verde
-- del proyecto es lo que avisa cuando esto se descuida.

revoke execute on function activities_set_sync_key() from public, anon, authenticated;
revoke execute on function activities_edicion_guard() from public, anon, authenticated;
revoke execute on function activities_audit()        from public, anon, authenticated;
revoke execute on function events_guard()            from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Verificación
-- ---------------------------------------------------------------------------

do $$
declare
  n_sin_clave integer;
begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'activities' and column_name = 'edited_at') then
    raise exception '0051: activities.edited_at no quedó creada';
  end if;

  select count(*) into n_sin_clave from activities where sync_key is null;
  if n_sin_clave > 0 then
    raise exception '0051: quedaron % actividades sin sync_key — el cron las duplicaría', n_sin_clave;
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'activities_edicion_guard_trg') then
    raise exception '0051: el guard de edición no quedó montado';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'activities_audit_trg') then
    raise exception '0051: el audit de actividades no quedó montado';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'activities_sync_key_trg') then
    raise exception '0051: el trigger de sync_key no quedó montado';
  end if;

  if not exists (
    select 1 from pg_policies
     where tablename = 'events' and policyname = 'events_update'
       and qual like '%auth.uid()%'
  ) then
    raise exception '0051: events_update no quedó acotada al autor';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'events_guard_trg') then
    raise exception '0051: el guard de events no quedó montado';
  end if;

  -- el recompute tiene que seguir corriendo en alta y baja, y solo condicionado
  -- en la corrección
  if not exists (select 1 from pg_trigger where tgname = 'activities_recompute_trg') then
    raise exception '0051: se perdió el recompute de alta/baja de actividades';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'activities_recompute_upd_trg') then
    raise exception '0051: no quedó el recompute condicional del update';
  end if;

  -- lo mismo que mira el chequeo 1 de scripts/security-checks.ts
  if exists (
    select 1 from pg_proc p
     where p.proname in ('activities_set_sync_key','activities_edicion_guard',
                         'activities_audit','events_guard')
       and p.prosecdef
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception '0051: alguna función nueva quedó ejecutable por anon';
  end if;

  raise notice '0051 OK: se corrige la nota propia, la fecha y el tipo quedan quietos, y el sync no duplica.';
end $$;

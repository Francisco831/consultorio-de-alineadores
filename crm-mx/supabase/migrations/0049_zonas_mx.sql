-- 0049 — Las 6 zonas comerciales de México, y el Estado como dato de verdad.
--
-- Pedido de Juan por WhatsApp (27/8/26), sobre la ficha "Datos de contacto":
-- "para poner la data del Dr, de la ubicación, en Zona debería tener: Norte,
-- Bajío, CDMX, Centro, Occidente, Sur … y sumarle una celda de: Estado. Debería
-- de tener por ejemplo: Estado: Nuevo León, Ciudad: Monterrey, Zona: Norte."
--
-- QUÉ ESTABA MAL
-- 1. El desplegable de Zona ofrecía CDMX / Norte / Sur / Foráneos. "Foráneos" no
--    es una zona: es el cajón donde `derive_zona()` (scripts/parse_enrichment.py)
--    tiraba todo lo que no caía en las otras tres. Ahí terminaron 58 fichas —un
--    tercio de las que tienen zona— con Guadalajara, Querétaro, Cuernavaca y Los
--    Cabos bajo la misma etiqueta. El corte "Por zona" de Reportes leía eso.
-- 2. `doctors.state` existía desde 0002 y ningún formulario lo escribía: solo lo
--    llenaban los imports. Y uno lo llenó mal: el tab "Contactados" de b-learning
--    mapeó a `state` una columna que era el canal/estado de contacto, así que hay
--    564 fichas cuyo "estado" dice whatsapp, No contesta, Instagram, Interesado,
--    Quiere informacion, Inscrito- Pagado o llamada realizada. Eso ya se filtra
--    hoy al panel (`d.state ?? d.zona`), y con la celda nueva quedaría a la vista
--    en cada ficha.
--
-- QUÉ HACE ESTA MIGRACIÓN
--   a) Guarda state y zona viejos en ops.geo_0049_backup (el rollback sale de ahí).
--   b) Normaliza `state` a las 32 entidades: Queretaro→Querétaro, CDMX→Ciudad de
--      México, Nuevo Leon→Nuevo León, etc. Sin esto el <select> nuevo no matchea
--      el valor guardado y la ficha pierde el estado en cuanto alguien la edita.
--   c) Lo que no es una entidad federativa sale de `state` y queda archivado en
--      `custom.estado_crudo`. No se borra nada: si mañana se quiere reconstruir
--      de dónde salió ese "No contesta", está.
--   d) Reescribe las 171 zonas existentes con el mapa nuevo (zona = función del
--      estado). NO le pone zona a las 7.008 fichas que hoy no tienen: eso es una
--      decisión comercial, no una migración, y el equipo las carga a mano.
--   e) Deja un CHECK: de acá en más `zona` solo puede ser una de las seis.
--
-- El mapa estado→zona es el mismo de lib/geo-mx.ts y de parse_enrichment.py.
-- Rollback: supabase/rollbacks/0049_zonas_mx_rollback.sql

-- ---------------------------------------------------------------- a) backup
create table if not exists ops.geo_0049_backup (
  doctor_id uuid primary key references doctors(id) on delete cascade,
  state_old text,
  zona_old  text,
  saved_at  timestamptz not null default now()
);
comment on table ops.geo_0049_backup is
  'Foto de doctors.state y doctors.zona ANTES de 0049. Es lo único que hace '
  'reversible la migración: 0049 reescribe datos, no solo schema.';
revoke all on table ops.geo_0049_backup from public, anon, authenticated;
grant select, insert, update, delete on table ops.geo_0049_backup to service_role;
alter table ops.geo_0049_backup enable row level security;
drop policy if exists geo_0049_backup_service on ops.geo_0049_backup;
create policy geo_0049_backup_service on ops.geo_0049_backup
  to service_role using (true) with check (true);

insert into ops.geo_0049_backup (doctor_id, state_old, zona_old)
select id, state, zona from doctors where state is not null or zona is not null
on conflict (doctor_id) do nothing;

-- ---------------------------------------------------------------- el mapa
-- Vive en una tabla temporaria de la transacción: fuera de esta migración no
-- tiene por qué existir nada nuevo en la base.
create temporary table geo_alias (
  alias  text primary key,   -- minúsculas y sin acentos
  estado text not null,      -- entidad canónica, como se guarda en doctors.state
  zona   text not null
) on commit drop;

insert into geo_alias (alias, estado, zona) values
  -- las 32 entidades
  ('aguascalientes',      'Aguascalientes',      'Bajío'),
  ('baja california',     'Baja California',     'Norte'),
  ('baja california sur', 'Baja California Sur', 'Norte'),
  ('campeche',            'Campeche',            'Sur'),
  ('chiapas',             'Chiapas',             'Sur'),
  ('chihuahua',           'Chihuahua',           'Norte'),
  ('ciudad de mexico',    'Ciudad de México',    'CDMX'),
  ('coahuila',            'Coahuila',            'Norte'),
  ('colima',              'Colima',              'Occidente'),
  ('durango',             'Durango',             'Norte'),
  ('estado de mexico',    'Estado de México',    'Centro'),
  ('guanajuato',          'Guanajuato',          'Bajío'),
  ('guerrero',            'Guerrero',            'Sur'),
  ('hidalgo',             'Hidalgo',             'Centro'),
  ('jalisco',             'Jalisco',             'Occidente'),
  ('michoacan',           'Michoacán',           'Occidente'),
  ('morelos',             'Morelos',             'Centro'),
  ('nayarit',             'Nayarit',             'Occidente'),
  ('nuevo leon',          'Nuevo León',          'Norte'),
  ('oaxaca',              'Oaxaca',              'Sur'),
  ('puebla',              'Puebla',              'Centro'),
  ('queretaro',           'Querétaro',           'Bajío'),
  ('quintana roo',        'Quintana Roo',        'Sur'),
  ('san luis potosi',     'San Luis Potosí',     'Bajío'),
  ('sinaloa',             'Sinaloa',             'Norte'),
  ('sonora',              'Sonora',              'Norte'),
  ('tabasco',             'Tabasco',             'Sur'),
  ('tamaulipas',          'Tamaulipas',          'Norte'),
  ('tlaxcala',            'Tlaxcala',            'Centro'),
  ('veracruz',            'Veracruz',            'Sur'),
  ('yucatan',             'Yucatán',             'Sur'),
  ('zacatecas',           'Zacatecas',           'Bajío'),
  -- alias de escritura que ya están en la base
  ('bc',                  'Baja California',     'Norte'),
  ('bcn',                 'Baja California',     'Norte'),
  ('bcs',                 'Baja California Sur', 'Norte'),
  ('cdmx',                'Ciudad de México',    'CDMX'),
  ('distrito federal',    'Ciudad de México',    'CDMX'),
  ('df',                  'Ciudad de México',    'CDMX'),
  ('edo mex',             'Estado de México',    'Centro'),
  ('edomex',              'Estado de México',    'Centro'),
  ('edo de mexico',       'Estado de México',    'Centro'),
  ('estado mexico',       'Estado de México',    'Centro'),
  ('nle',                 'Nuevo León',          'Norte'),
  ('michoacan de ocampo', 'Michoacán',           'Occidente'),
  ('veracruz de ignacio de la llave', 'Veracruz','Sur'),
  ('coahuila de zaragoza','Coahuila',            'Norte'),
  -- "México" a secas es ambiguo (país, capital o Estado de México). La única
  -- ficha que lo tiene como estado ya venía clasificada CDMX por el import
  -- viejo, y su ciudad también dice México: se respeta esa lectura.
  ('mexico',              'Ciudad de México',    'CDMX');

-- Ciudades: SOLO se usan para recuperar la zona de las fichas que hoy tienen
-- zona y no tienen estado. No se escriben en `state` — deducir el estado desde
-- la ciudad es una inferencia, y `state` es un dato que el equipo carga.
create temporary table geo_ciudad (alias text primary key, zona text not null) on commit drop;
insert into geo_ciudad (alias, zona) values
  ('baja california norte',  'Norte'),
  ('los cabos',              'Norte'),      -- Baja California Sur
  ('san luis rio colorado',  'Norte'),      -- Sonora
  ('sl potosi',              'Bajío'),      -- San Luis Potosí
  ('playa del carmen',       'Sur'),        -- Quintana Roo
  -- IMED y UDG son escuelas de Guadalajara, no lugares: entraron así en el
  -- import de 2022 y una de las fichas lo dice entera ("Guadalajara/IMED").
  ('guadalajara/imed',       'Occidente'),
  ('imed',                   'Occidente'),
  ('udg',                    'Occidente');

-- ---------------------------------------------------------------- b) y c) state
-- Normalizar lo que SÍ es una entidad federativa.
update doctors d
   set state = a.estado
  from geo_alias a
 where d.state is not null
   and a.alias = lower(translate(btrim(d.state), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'))
   and d.state is distinct from a.estado;

-- Archivar y sacar lo que no lo es (whatsapp, No contesta, Interesado, …).
update doctors d
   set custom = d.custom || jsonb_build_object('estado_crudo', d.state),
       state  = null
 where d.state is not null
   and not exists (
     select 1 from geo_alias a
      where a.alias = lower(translate(btrim(d.state), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'))
   );

-- ---------------------------------------------------------------- d) zona
-- Solo las fichas que YA tenían zona. El estado manda; la ciudad es el recurso
-- de última instancia. Si no se puede deducir, la zona queda vacía: un campo en
-- blanco se ve y se completa, un cajón equivocado no.
update doctors d
   set zona = coalesce(
     (select a.zona from geo_alias a where a.alias = lower(translate(btrim(d.state), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'))),
     (select c.zona from geo_ciudad c where c.alias = lower(translate(btrim(d.city),  'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'))),
     (select a.zona from geo_alias a where a.alias = lower(translate(btrim(d.city),  'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')))
   )
 where d.zona is not null;

-- ---------------------------------------------------------------- e) candado
alter table doctors drop constraint if exists doctors_zona_valida;
alter table doctors add constraint doctors_zona_valida
  check (zona is null or zona in ('Norte', 'Bajío', 'CDMX', 'Centro', 'Occidente', 'Sur'));

comment on column doctors.zona is
  'Zona comercial de México: Norte | Bajío | CDMX | Centro | Occidente | Sur '
  '(pedido de Juan, 27/8/26; el CHECK doctors_zona_valida no admite otra). Es '
  'función del estado — Nuevo León es Norte— y el mapa vive en lib/geo-mx.ts.';
comment on column doctors.state is
  'Entidad federativa, una de las 32, escrita como en lib/geo-mx.ts. La carga el '
  'formulario "Datos de contacto" con un <select>, así que no admite texto libre. '
  'Lo que había antes y no era un estado quedó en custom.estado_crudo (0049).';

-- ---------------------------------------------------------------- verificación
do $$
declare
  v_zona_mala int; v_estado_malo int; v_zona_null int; v_archivados int;
  r record;
begin
  select count(*) into v_zona_mala from doctors
   where zona is not null and zona not in ('Norte','Bajío','CDMX','Centro','Occidente','Sur');
  if v_zona_mala > 0 then
    raise exception '0049: quedaron % fichas con una zona fuera de las seis', v_zona_mala;
  end if;

  select count(*) into v_estado_malo from doctors d
   where d.state is not null
     and not exists (select 1 from geo_alias a
                      where a.alias = lower(translate(btrim(d.state), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')));
  if v_estado_malo > 0 then
    raise exception '0049: quedaron % fichas con un state que no es una entidad federativa', v_estado_malo;
  end if;

  select count(*) into v_zona_null from ops.geo_0049_backup b
    join doctors d on d.id = b.doctor_id
   where b.zona_old is not null and d.zona is null;
  select count(*) into v_archivados from doctors where custom ? 'estado_crudo';

  raise notice '0049 OK — zonas nuevas:';
  for r in select zona, count(*) n from doctors where zona is not null group by zona order by 1 loop
    raise notice '    % : %', rpad(r.zona, 10), r.n;
  end loop;
  raise notice '  fichas con estado normalizado: %', (select count(*) from doctors where state is not null);
  raise notice '  estados archivados en custom.estado_crudo: %', v_archivados;
  raise notice '  fichas que tenían zona y quedaron sin ella (no se pudo deducir): %', v_zona_null;
end $$;

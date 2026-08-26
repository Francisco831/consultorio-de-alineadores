-- 0045 — La verdad sobre qué renders están esperando aprobación: espejo del
-- portal keepsmiling-v2 en `cases`.
--
-- EL PROBLEMA. Desde 0002 el CRM define "render esperando aprobación" como
-- `fecha_video is not null and fecha_aprobacion_video is null`, con los datos que
-- baja el sync de ks-indicadores (xanoCasos). Medido contra producción el 26/8:
-- 98 casos cumplen esa condición. Cruzándolos uno por uno contra keepsmiling-v2
-- (mismo día, por idExterno):
--     62 están de verdad en stage ATENCION  → esperan al doctor
--     34 están en stage RECHAZADO           → el doctor YA contestó: rechazó
--      2 ya avanzaron a otro stage (BV988, AO569): nadie cerró la fecha
-- O sea: más de un tercio de la lista que hoy ve el equipo no es trabajo
-- pendiente del doctor. Y no hay forma de arreglarlo con las fechas que ya
-- tenemos: `fecha_aprobacion_video` sólo se llena cuando aprueban, un rechazo la
-- deja en NULL para siempre; `fecha_entrega` viene 0% llena y `fecha_finalizado`
-- 36%, así que tampoco sirven de corte.
--
-- DE DÓNDE SALE LA VERDAD. En keepsmiling-v2 (el portal de producción, el mismo
-- que ya usa lib/alerta-rechazos.ts) el estado vive en dos enums del caso:
--   · stage = ATENCION + subStage = PENDIENTE_APROBACION_RENDER → esperando
--   · stage = RECHAZADO + fechaRechazado                        → rechazado
-- Medido en vivo el 26/8 sobre los 1.058 casos MX del portal:
--     ATENCION   63  → los 63 con subStage PENDIENTE_APROBACION_RENDER y
--                      videoEstado SUBIDO; 63/63 matchean cases.id_externo (100%)
--     RECHAZADO  72  → 65 matchean (90%); 7 son casos viejos que el CRM nunca
--                      importó
-- OJO con el detalle que obliga a guardar las DOS columnas: 32 de los 72
-- rechazados siguen teniendo subStage = PENDIENTE_APROBACION_RENDER. El subStage
-- solo miente; hay que mirarlo junto con el stage.
--
-- Y la antigüedad, para que la pantalla no prometa lo que no es: de los 63 que
-- esperan de verdad, 9 tienen menos de 7 días, 5 entre 7 y 13, 5 entre 14 y 29,
-- 6 entre 30 y 89 y 38 más de 90 (mediana: 219 días). El backlog viejo es real,
-- no es ruido de fechas sin cerrar.
--
-- QUÉ HACE ESTA MIGRACIÓN: agrega el espejo (5 columnas) y el índice de la
-- consulta de la pantalla. Lo llena app/api/sync/render (lib/render-v2-sync.ts).
-- Mientras el sync no corra, las columnas quedan en NULL y nada se rompe: la
-- regla vieja de 0043/0044 sigue funcionando como hasta hoy.
--
-- Nota para el futuro: v2 también tiene `fechaVideoPublicado`, llena en 63/63
-- (fechaVideo está en 62/63). Si algún día la pantalla necesita "esperando
-- desde" exacto, ese es el campo a traer.
--
-- Rollback: supabase/rollbacks/0045_render_v2_rollback.sql

alter table cases
  add column if not exists video_stage          text,
  add column if not exists video_sub_stage      text,
  add column if not exists video_estado         text,
  add column if not exists fecha_rechazado      timestamptz,
  add column if not exists video_v2_synced_at   timestamptz;

comment on column cases.video_stage is
  'stage del caso en el portal keepsmiling-v2 (enum KeepsmilingCasosStage: INGRESO, EDICION, VIDEO, ATENCION, RECHAZADO, MOVIMIENTOS, IMPRESION, LOGISTICA, FINALIZADO…). Lo escribe /api/sync/render. ATENCION es el único stage que significa "la pelota la tiene el doctor"; fecha_video/fecha_aprobacion_video no distinguen eso (26/8: 34 de los 98 "pendientes" ya estaban rechazados).';

comment on column cases.video_sub_stage is
  'subStage del caso en keepsmiling-v2. PENDIENTE_APROBACION_RENDER = el render está publicado esperando respuesta. NO alcanza por sí solo: el 26/8, 32 de los 72 casos MX rechazados seguían con este subStage. Se lee siempre junto con video_stage.';

comment on column cases.video_estado is
  'videoEstado en keepsmiling-v2 (PENDIENTE, ROBOT, SUBIDO, REVISION, PUBLICADO…). Dice en qué anda el render del lado nuestro: los 63 casos MX esperando aprobación al 26/8 estaban todos en SUBIDO.';

comment on column cases.fecha_rechazado is
  'fechaRechazado de keepsmiling-v2: cuándo el doctor rechazó la propuesta. Es el dato que hoy le falta al CRM para separar rechazado de esperando — un rechazo deja fecha_aprobacion_video en NULL para siempre, así que sin esta columna los dos casos se ven iguales.';

comment on column cases.video_v2_synced_at is
  'Cuándo /api/sync/render escribió por última vez este caso. Sólo se toca cuando algo CAMBIÓ en v2 (cases tiene un trigger que recalcula la doctora en cada update: escribir las 1.051 filas de más sale caro). Para saber si el sync está corriendo, mirar sync_runs source=render-v2, no esta columna.';

-- La consulta de /seguimiento: renders esperando, del más viejo al más nuevo.
-- Parcial sobre el subStage (y no sobre el stage) a propósito: es el predicado
-- más chico —63 filas hoy, 95 contando los rechazados que lo conservan— y sirve
-- igual para las consultas que además filtran video_stage = 'ATENCION'.
create index if not exists cases_render_esperando_idx
  on cases (fecha_video)
  where video_sub_stage = 'PENDIENTE_APROBACION_RENDER';

do $$
declare v_viejo int; v_col int;
begin
  select count(*) into v_viejo from cases
   where fecha_video is not null and fecha_aprobacion_video is null;
  select count(*) into v_col from information_schema.columns
   where table_name = 'cases'
     and column_name in ('video_stage','video_sub_stage','video_estado',
                         'fecha_rechazado','video_v2_synced_at');
  raise notice '0045 OK: % columnas nuevas en cases. Criterio viejo: % casos "esperando" (de los que ~1/3 no lo están); la verdad la escribe /api/sync/render.', v_col, v_viejo;
end $$;

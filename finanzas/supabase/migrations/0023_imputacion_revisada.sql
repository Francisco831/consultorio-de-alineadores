-- 0023: el tilde de "ya lo miré y está bien", y el fin del NULL ambiguo.
--
-- La 0022 codificaba el destino de un cobro en professional_id: con valor, va a
-- esa doctora; en NULL, no va a nadie. Alcanzaba mientras la tabla sólo guardara
-- CORRECCIONES, pero Pancho necesita además marcar las líneas que revisó y
-- decidió dejar como vienen (regla suya, 25/8/26: "así ya lo confirmé, está
-- ok"). Eso es una tercera cosa —"respetá la caja"— que en el modelo viejo no
-- se puede distinguir de "no se liquida a nadie": las dos serían NULL.
--
-- Por eso el destino pasa a ser explícito y professional_id queda como el dato
-- que acompaña a un solo destino. Un NULL que significa dos cosas distintas es
-- una promesa de bug.

alter table settlement_imputations
  add column destino text not null default 'profesional'
    check (destino in ('caja', 'casa', 'profesional')),
  -- Revisado ≠ corregido: son las líneas que Pancho ya miró, para no volver a
  -- mirarlas el mes que viene. Cambiar el destino marca revisado solo (decidir
  -- ES revisar); tildar sin cambiar nada deja destino='caja'.
  add column revisado boolean not null default false,
  add column revisado_at timestamptz,
  add column revisado_by uuid;

-- Las filas que ya existen son las 4 de julio: todas "no se liquida a nadie",
-- y todas revisadas por definición (las decidió él).
update settlement_imputations
   set destino  = case when professional_id is null then 'casa' else 'profesional' end,
       revisado = true,
       revisado_at = coalesce(revisado_at, created_at);

-- El destino manda sobre professional_id, no al revés: sin esto, una fila
-- 'casa' con una doctora colgada (o una 'profesional' sin doctora) volvería a
-- dejar la pregunta "¿y entonces a quién se le liquida?" sin respuesta.
alter table settlement_imputations
  add constraint settlement_imputations_destino_coherente check (
    (destino = 'profesional' and professional_id is not null)
    or (destino in ('caja', 'casa') and professional_id is null)
  );

comment on column settlement_imputations.destino is
  'caja = respetá la columna doctora de la caja · casa = no se liquida a nadie, queda para Pancho · profesional = se le liquida a professional_id';

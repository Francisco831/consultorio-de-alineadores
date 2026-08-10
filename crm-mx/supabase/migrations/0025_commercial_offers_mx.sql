-- 0025 — Condiciones comerciales de México en CONFIGURACIÓN, no en el prompt.
--
-- Commercial Brain V1 (2026.08.2) exige que el precio de lista, los descuentos y
-- las campañas salgan de la configuración vigente y no de un texto hardcodeado.
-- La jerarquía de fuentes pone la decisión del dueño arriba de todo: Pancho
-- declaró el 9/8/2026 el precio de lista de la acreditación y las tres
-- condiciones de arranque de México. El lugar correcto para esa decisión es esta
-- tabla — así se edita sin tocar código y el agente la lee con
-- getActiveCommercialOffers.
--
-- Lo que NO está definido y queda declarado como tal: hasta cuándo rigen. Por eso
-- valid_to es null y las notas lo dicen. Para dar de baja una condición:
--   update commercial_offers set active = false where name = '...';
-- Idempotente: se puede correr varias veces.

-- ---------------------------------------------------------------------------
-- 1. Monto en pesos (la tabla solo tenía porcentaje)
-- ---------------------------------------------------------------------------

alter table commercial_offers
  add column if not exists amount_mxn numeric(12,2);

comment on column commercial_offers.amount_mxn is
  'Monto en MXN cuando la condición es un precio (p. ej. precio de lista de la '
  'acreditación), no un porcentaje. La capa AI solo puede citar números que '
  'salgan de esta tabla.';

do $$ begin
  alter table commercial_offers add constraint commercial_offers_amount_check
    check (amount_mxn is null or amount_mxn >= 0);
exception when duplicate_object then null; end $$;

-- Una condición sin porcentaje NI monto no dice nada: es ruido para el agente.
do $$ begin
  alter table commercial_offers add constraint commercial_offers_has_value_check
    check (percentage is not null or amount_mxn is not null);
exception when duplicate_object then null; end $$;

-- Clave natural para poder re-correr la migración sin duplicar filas.
create unique index if not exists commercial_offers_market_name_key
  on commercial_offers (market, name);

-- ---------------------------------------------------------------------------
-- 2. Las condiciones vigentes declaradas por dirección (9/8/2026)
-- ---------------------------------------------------------------------------

insert into commercial_offers
  (market, name, offer_type, lifecycle_stage, percentage, amount_mxn,
   valid_from, valid_to, conditions, requires_approval, active, notes)
values
  ('MX',
   'Acreditación México — precio de lista',
   'precio_lista',
   null,
   null,
   4990.00,
   date '2026-08-09',
   null,
   'Precio de lista del curso de acreditación en México (2 días, dictado por doctores, modalidad presencial/virtual/híbrida). Es el precio ANTES del descuento vigente.',
   false,
   true,
   'Declarado por dirección (Pancho) el 9/8/2026. Fecha de fin PENDIENTE DE DEFINICIÓN. Los materiales de curso documentan 2.500 MXN presencial / 1.900 MXN virtual, que es aproximadamente este precio con el descuento vigente aplicado — inferencia sin confirmar.'),

  ('MX',
   'Acreditación México — descuento vigente',
   'descuento_acreditacion',
   null,
   50.00,
   null,
   date '2026-08-09',
   null,
   'Descuento habitual sobre el precio de lista de la acreditación. Se comunica como parte de la puerta de entrada al sistema (capacitación + ecosistema + acompañamiento), NUNCA como "pague un curso para poder comprarnos".',
   false,
   true,
   'Declarado por dirección (Pancho) el 9/8/2026 ("suele tener 50% de descuento"). Fecha de fin PENDIENTE DE DEFINICIÓN.'),

  ('MX',
   'Caso propio del doctor — descuento de arranque',
   'descuento_caso_propio',
   null,
   50.00,
   null,
   date '2026-08-09',
   null,
   'Descuento sobre el tratamiento del propio doctor (caso propio). Aplica una vez, al primer hito del journey post-acreditación. Se comunica como experiencia, no como promoción: el doctor vive el sistema completo.',
   false,
   true,
   'Declarado por dirección (Pancho) el 9/8/2026. Fecha de fin y tope PENDIENTES DE DEFINICIÓN. Resuelve el pendiente #1 del Brain 2026.08 sobre el esquema de arranque de México.'),

  ('MX',
   'Primer caso de paciente — descuento de arranque',
   'descuento_primer_caso',
   null,
   50.00,
   null,
   date '2026-08-09',
   null,
   'Descuento sobre el PRIMER caso de paciente del doctor (Conversión 2), distinto del caso propio. Junto con los dos anteriores, hace que la acreditación pueda justificarse por la propia experiencia de inicio — pero NO se vende como una cuenta matemática.',
   false,
   true,
   'Declarado por dirección (Pancho) el 9/8/2026. Fecha de fin y tope PENDIENTES DE DEFINICIÓN.')
on conflict (market, name) do nothing;

-- Las tres condiciones de arranque NO se atan a una sola etapa del lifecycle:
-- el precio le importa a un interesado y a uno con fecha agendada, y el
-- descuento del primer caso de paciente le importa tanto a 'en_activacion' como
-- a 'activado'. Quién aplica lo dice el texto de `conditions`, no un tag que
-- dejaría al agente sin la condición justo cuando la necesita.
update commercial_offers
   set lifecycle_stage = null
 where market = 'MX'
   and lifecycle_stage is not null
   and offer_type in ('precio_lista', 'descuento_acreditacion',
                      'descuento_caso_propio', 'descuento_primer_caso');

-- ---------------------------------------------------------------------------
-- 3. Verificación
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  select count(*) into n
    from commercial_offers
    where market = 'MX' and active and (valid_to is null or valid_to >= current_date);
  raise notice '0025: % condicion(es) comercial(es) vigente(s) para MX', n;
end $$;

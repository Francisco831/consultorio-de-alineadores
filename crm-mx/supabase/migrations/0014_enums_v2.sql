-- 0014: enums del modelo de DOS UNIVERSOS (no acreditados vs acreditados).
-- Solo ADD VALUE + tipos nuevos: los valores nuevos de un enum no se pueden usar
-- en la misma transacción que los crea → el uso vive en 0015.
--
-- Lifecycle completo del journey comercial (14 etapas):
--   prospecto → contactado → calificacion → interes_acreditacion →
--   acreditacion_agendada → acreditado → en_activacion → activado →
--   activo → growth → en_riesgo → dormido → reactivado → perdido
-- 'acreditacion_pendiente' y 'acreditado_no_activado' quedan deprecados
-- (Postgres no permite borrar valores de enum; 0015 migra las filas).

alter type lifecycle_stage add value if not exists 'contactado' after 'prospecto';
alter type lifecycle_stage add value if not exists 'calificacion' after 'contactado';
alter type lifecycle_stage add value if not exists 'interes_acreditacion' after 'calificacion';
alter type lifecycle_stage add value if not exists 'acreditacion_agendada' after 'interes_acreditacion';
alter type lifecycle_stage add value if not exists 'activado' after 'en_activacion';
alter type lifecycle_stage add value if not exists 'reactivado' after 'dormido';

-- fuentes de lead ampliadas (¿de dónde vienen los doctores que terminan comprando?)
alter type attribution_source add value if not exists 'congreso';
alter type attribution_source add value if not exists 'instagram';
alter type attribution_source add value if not exists 'website';
alter type attribution_source add value if not exists 'universidad';
alter type attribution_source add value if not exists 'partnership';
alter type attribution_source add value if not exists 'otro';

-- pipeline de ADQUISICIÓN de doctores (universo NO acreditado; termina en acreditado)
create type acq_stage as enum (
  'identificado','contacto_intentado','contactado','calificado',
  'reunion_agendada','reunion_realizada','interes_acreditacion',
  'acreditacion_agendada','acreditado','no_interesado'
);

-- pipeline de ACTIVACIÓN (universo acreditado sin primer caso pagado)
create type act_stage as enum (
  'acreditado','contactado_post','paciente_potencial','documentacion',
  'caso_ingresado','planificacion','presentado','primer_caso_pagado'
);

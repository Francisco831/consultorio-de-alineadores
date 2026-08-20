-- 0015: el matcher aprendió un caso real que faltaba.
--
-- El paciente paga en DOS transferencias el mismo día y la caja lo anota como un
-- solo cobro (Badiola: 400.000 + 234.000 en el extracto = 634.000 en la caja).
-- Hasta acá esas líneas quedaban "no identificadas" y parecían plata faltante:
-- 8 líneas por $2,4M que en realidad ya estaban registradas.
--
-- La conciliación N líneas → 1 movimiento ya la permitía el unique
-- (statement_line_id, movement_id); solo faltaba el método en el check.

alter table match_suggestions drop constraint if exists match_suggestions_method_check;
alter table match_suggestions add constraint match_suggestions_method_check
  check (method in (
    'external_key', 'nombre_monto_fecha', 'agrupado',
    'lineas_agrupadas',
    'monto_unico', 'sobrante_mutuo'
  ));

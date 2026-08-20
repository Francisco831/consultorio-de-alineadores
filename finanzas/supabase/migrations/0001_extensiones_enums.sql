-- 0001: extensiones y enums del dominio financiero.
-- pg_trgm: prefiltro SQL del matcher de conciliación y búsqueda global.

create extension if not exists pg_trgm;

-- El monto es SIEMPRE positivo; el signo lo da el kind (columna generada
-- signed_amount). Las transferencias internas quedan fuera de ingreso/gasto
-- por tipo, no por convención de quien consulta.
create type movement_kind as enum (
  'income', 'expense', 'transfer_in', 'transfer_out', 'adjustment'
);

-- pending: cargado pero sin confirmar (ej: transferencia no acreditada, o fila
--   sembrada sin medio de pago identificable). "Transferencia no acreditada = no
--   pagada" (regla de la caja del consultorio).
-- confirmed: impactó la cuenta. void: anulado con historial, nunca DELETE.
create type movement_status as enum ('pending', 'confirmed', 'void');

-- Estado de una línea de extracto en la conciliación (spec de Pancho):
-- pending=Pendiente · suggested=Posible coincidencia · matched=Conciliado ·
-- unidentified=No identificado · duplicate=Duplicado · ignored=descartada a mano.
create type statement_line_status as enum (
  'pending', 'suggested', 'matched', 'unidentified', 'duplicate', 'ignored'
);

create type membership_role as enum ('owner', 'admin', 'operator', 'viewer');

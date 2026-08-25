-- 0025: lo que el recálculo YA sabe y nadie ve.
--
-- El motor de liquidaciones detecta en cada corrida tres cosas que cuestan
-- plata, y hasta hoy sólo las veía quien corriera el script en una terminal:
--
--  1. COBROS SIN COSTEAR: no se les pudo poner precio (falta el pacto del
--     paciente y la caja no dice "cuota N de Y"). Entran a la liquidación con
--     costo KS $0, así que a la doctora se le paga el 40% del BRUTO en vez del
--     neto. Al 26/8/26 son 12 cobros por $12,5M — cuatro de ellos ya pagados.
--  2. IMPUTACIONES HUÉRFANAS: una corrección apunta a un movimiento que la caja
--     editó y quedó anulado. La corrección ya no hace nada.
--  3. COBROS TRABADOS: el cálculo los movería de doctora, pero siguen liquidados
--     en una liquidación cerrada.
--
-- Por qué una tabla y no calcularlo al abrir la pantalla: el cálculo completo
-- tarda ~3 segundos (984 movimientos, medido). Persistirlo deja el panel
-- instantáneo y —más importante— con UNA sola fuente: el mismo motor que
-- liquida. Leer los ítems guardados no alcanzaba: las liquidaciones cerradas
-- sin detalle no tienen línea, y justo ahí están los cobros más grandes.
--
-- La tabla es un ESPEJO del último cálculo: se reescribe entera en cada
-- recálculo. No es historia, es estado.

create table settlement_issues (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  kind         text not null
    check (kind in ('sin_costear', 'imputacion_huerfana', 'cobro_trabado')),
  -- Sin FK a movements a propósito: una imputación huérfana apunta justamente a
  -- un movimiento que ya no existe, y una FK haría imposible registrarla.
  movement_id  uuid,
  period       text,
  professional text,
  amount       numeric(14,2),
  currency     char(3),
  detail       text not null,
  detected_at  timestamptz not null default now()
);

comment on table settlement_issues is
  'Espejo del último recálculo: cobros sin costear, imputaciones huérfanas y cobros trabados. Se reescribe entera en cada corrida.';

create index settlement_issues_empresa on settlement_issues (company_id, kind);

alter table settlement_issues enable row level security;

create policy settlement_issues_select on settlement_issues for select to authenticated
  using (company_id in (select private.member_companies()));

-- Lo escribe el recálculo, que corre como el usuario que aprieta el botón.
create policy settlement_issues_insert on settlement_issues for insert to authenticated
  with check (private.has_role(company_id, array['owner','admin','operator']));
create policy settlement_issues_delete on settlement_issues for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));

grant select, insert, delete on settlement_issues to authenticated;
grant select, insert, update, delete on settlement_issues to service_role;

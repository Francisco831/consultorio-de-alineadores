-- 0022: a quién se le liquida CADA cobro, cuando la caja no lo dice bien.
--
-- Hasta hoy la columna "doctora" de la caja de Claudia ERA la liquidación: si la
-- fila decía Franco, el 40% se le liquidaba a Franco. Pero esa columna anota
-- quién estaba en el consultorio, no quién hizo el tratamiento. Cuando la
-- paciente sólo pasa a RETIRAR sus alineadores o su contención no hay trabajo
-- profesional detrás: esa plata no se le liquida a nadie y queda para la casa
-- (regla de Pancho, 25/8/2026, de julio en adelante).
--
-- POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA EN movements: el importador de la
-- caja hace upsert de la fila COMPLETA en cada corrida
-- (scripts/import-movimientos-ar.ts), así que una corrección guardada en el
-- movimiento se pisaría sola a la mañana siguiente. Acá no la toca nadie más
-- que la app.
--
-- OJO: la external_key de la caja es de CONTENIDO (editar una fila = clave
-- nueva = movimiento nuevo). Si Claudia corrige el monto o el texto de una fila
-- imputada a mano, el movimiento viejo queda anulado y la imputación se queda
-- sin efecto: el recálculo lo reporta como huérfana en vez de aplicarla en
-- silencio a algo que ya no existe.

create table settlement_imputations (
  -- id propio (no la PK natural movement_id) porque el trigger genérico de
  -- auditoría anota new.id: sin esta columna, cada escritura reventaría
  id              uuid primary key default gen_random_uuid(),
  movement_id     uuid not null,
  company_id      uuid not null references companies (id),
  -- A QUIÉN se le liquida este cobro. NULL = a NADIE: queda para la casa.
  -- Que la fila EXISTA ya es la decisión; su ausencia significa "lo que dice
  -- la caja". Por eso el destino "nadie" no se puede representar borrando.
  professional_id uuid,
  reason          text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (movement_id, company_id)     references movements (id, company_id),
  foreign key (professional_id, company_id) references counterparties (id, company_id),
  -- un cobro tiene UNA imputación: el upsert de la app la pisa, no la duplica
  unique (movement_id)
);

create index settlement_imputations_company_idx on settlement_imputations (company_id);

create trigger settlement_imputations_updated_at
  before update on settlement_imputations for each row execute function set_updated_at();

-- ---------- RLS y grants (mismo criterio que la 0007/0010/0014) ----------
alter table settlement_imputations enable row level security;

create policy settlement_imputations_select on settlement_imputations
  for select to authenticated
  using (company_id in (select private.member_companies()));

create policy settlement_imputations_insert on settlement_imputations
  for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

create policy settlement_imputations_update on settlement_imputations
  for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

-- DELETE sí: borrar la imputación es "volvé a lo que dice la caja", que es una
-- operación real y reversible. No se borra plata, se borra una corrección.
create policy settlement_imputations_delete on settlement_imputations
  for delete to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']));

grant select, insert, update, delete on settlement_imputations to authenticated;
grant select, insert, update, delete on settlement_imputations to service_role;

-- el historial de quién cambió una imputación importa tanto como el de la plata
create trigger settlement_imputations_audit
  after insert or update on settlement_imputations
  for each row execute function audit_row_changes();

revoke all on settlement_imputations from anon;

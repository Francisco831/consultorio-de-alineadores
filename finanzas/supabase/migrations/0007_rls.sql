-- 0007: RLS completa. NINGUNA tabla queda sin policy.
-- El aislamiento por empresa es una POLICY, no una convención de query
-- (la lección del `using (true)` del CRM, al revés).
-- Patrón: SELECT = miembro de la empresa; INSERT/UPDATE = miembro con rol
-- operator+; DELETE = sin policy en tablas de plata (void por update, auditado).

-- helper local del archivo: rol con permiso de escritura
-- (owner/admin/operator escriben; viewer solo lee)

alter table companies enable row level security;
create policy companies_select on companies for select to authenticated
  using (id in (select private.member_companies()));
-- companies se administra por seed/service role; sin escritura de clientes.

alter table memberships enable row level security;
create policy memberships_select on memberships for select to authenticated
  using (user_id = auth.uid()
         or private.has_role(company_id, array['owner', 'admin']));
-- altas/bajas de miembros: solo service role (script de administración).

alter table accounts enable row level security;
create policy accounts_select on accounts for select to authenticated
  using (company_id in (select private.member_companies()));
create policy accounts_insert on accounts for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy accounts_update on accounts for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table categories enable row level security;
create policy categories_select on categories for select to authenticated
  using (company_id in (select private.member_companies()));
create policy categories_insert on categories for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy categories_update on categories for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table counterparties enable row level security;
create policy counterparties_select on counterparties for select to authenticated
  using (company_id in (select private.member_companies()));
create policy counterparties_insert on counterparties for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy counterparties_update on counterparties for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table movements enable row level security;
create policy movements_select on movements for select to authenticated
  using (company_id in (select private.member_companies()));
create policy movements_insert on movements for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy movements_update on movements for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
-- sin policy de DELETE: anular es void_movement(), nunca borrar.

alter table audit_log enable row level security;
create policy audit_log_select on audit_log for select to authenticated
  using (company_id in (select private.member_companies()));
-- escritura: solo triggers (security definer) y service role.

alter table documents enable row level security;
create policy documents_select on documents for select to authenticated
  using (company_id in (select private.member_companies()));
create policy documents_insert on documents for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table import_batches enable row level security;
create policy import_batches_select on import_batches for select to authenticated
  using (company_id in (select private.member_companies()));
create policy import_batches_insert on import_batches for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy import_batches_update on import_batches for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table statement_lines enable row level security;
create policy statement_lines_select on statement_lines for select to authenticated
  using (company_id in (select private.member_companies()));
create policy statement_lines_insert on statement_lines for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy statement_lines_update on statement_lines for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table reconciliations enable row level security;
create policy reconciliations_select on reconciliations for select to authenticated
  using (company_id in (select private.member_companies()));
create policy reconciliations_insert on reconciliations for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy reconciliations_delete on reconciliations for delete to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']));
-- desconciliar SÍ es un delete legítimo (el vínculo, no la plata) y queda
-- registrado por audit de la línea (match_status vuelve a pending).

alter table match_suggestions enable row level security;
create policy match_suggestions_select on match_suggestions for select to authenticated
  using (company_id in (select private.member_companies()));
create policy match_suggestions_insert on match_suggestions for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy match_suggestions_delete on match_suggestions for delete to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table payment_method_aliases enable row level security;
create policy pma_select on payment_method_aliases for select to authenticated
  using (company_id in (select private.member_companies()));
create policy pma_insert on payment_method_aliases for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy pma_update on payment_method_aliases for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy pma_delete on payment_method_aliases for delete to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table import_templates enable row level security;
create policy import_templates_select on import_templates for select to authenticated
  using (company_id in (select private.member_companies()));
create policy import_templates_insert on import_templates for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy import_templates_update on import_templates for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy import_templates_delete on import_templates for delete to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table transfer_rules enable row level security;
create policy transfer_rules_select on transfer_rules for select to authenticated
  using (company_id in (select private.member_companies()));
create policy transfer_rules_insert on transfer_rules for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy transfer_rules_update on transfer_rules for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));
create policy transfer_rules_delete on transfer_rules for delete to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']));

alter table sync_runs enable row level security;
create policy sync_runs_select on sync_runs for select to authenticated
  using (company_id is null or company_id in (select private.member_companies()));
-- escritura de sync_runs: solo service role (crons/scripts).

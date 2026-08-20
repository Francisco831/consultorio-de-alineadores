-- 0014: RLS y grants de las tablas de la Etapa 2.
-- Mismo criterio que la 0007/0010: ninguna tabla sin policy, aislamiento por
-- membresía de empresa, y la plata no se borra.

do $$
declare t text;
begin
  foreach t in array array[
    'patients', 'treatment_plans', 'receivables', 'receivable_applications',
    'recurring_rules', 'taxes', 'payables', 'payable_payments', 'tax_obligations',
    'employees', 'payroll_runs', 'payroll_items',
    'professionals', 'ks_price_list', 'professional_settlements', 'settlement_items'
  ] loop
    execute format('alter table %I enable row level security', t);

    execute format($p$
      create policy %I on %I for select to authenticated
        using (company_id in (select private.member_companies()))
    $p$, t || '_select', t);

    execute format($p$
      create policy %I on %I for insert to authenticated
        with check (private.has_role(company_id, array['owner','admin','operator']))
    $p$, t || '_insert', t);

    execute format($p$
      create policy %I on %I for update to authenticated
        using (private.has_role(company_id, array['owner','admin','operator']))
        with check (private.has_role(company_id, array['owner','admin','operator']))
    $p$, t || '_update', t);

    -- grants de tabla (este proyecto no los da por defecto)
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format('grant select, insert, update, delete on %I to service_role', t);
  end loop;
end $$;

-- DELETE solo donde borrar es la operación correcta: desaplicar un cobro o un
-- pago (se borra el VÍNCULO, el movimiento queda), y limpiar el detalle de una
-- liquidación en borrador. Las deudas se anulan con status, nunca se borran.
create policy receivable_applications_delete on receivable_applications
  for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));
create policy payable_payments_delete on payable_payments
  for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));
create policy settlement_items_delete on settlement_items
  for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));
create policy payroll_items_delete on payroll_items
  for delete to authenticated
  using (private.has_role(company_id, array['owner','admin','operator']));

grant delete on receivable_applications to authenticated;
grant delete on payable_payments to authenticated;
grant delete on settlement_items to authenticated;
grant delete on payroll_items to authenticated;

grant select on v_receivables_aging to authenticated, service_role;
grant select on v_payables_buckets  to authenticated, service_role;

-- audit de las tablas de compromisos (el historial de la plata prometida importa
-- tanto como el de la plata movida)
create trigger receivables_audit
  after insert or update on receivables
  for each row execute function audit_row_changes();
create trigger payables_audit
  after insert or update on payables
  for each row execute function audit_row_changes();
create trigger tax_obligations_audit
  after insert or update on tax_obligations
  for each row execute function audit_row_changes();
create trigger professional_settlements_audit
  after insert or update on professional_settlements
  for each row execute function audit_row_changes();
create trigger treatment_plans_audit
  after insert or update on treatment_plans
  for each row execute function audit_row_changes();

revoke all on all tables in schema public from anon;

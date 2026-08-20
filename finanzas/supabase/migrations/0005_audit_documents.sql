-- 0005: trazabilidad. Un solo audit_log append-only para todo el sistema
-- (patrón heredado del CRM) + documentos adjuntos en Storage.

create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id),
  entity_type text not null,
  entity_id   uuid not null,
  field       text not null,
  old_value   text,
  new_value   text,
  actor_id    uuid,
  source      text not null default 'app',
  created_at  timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (company_id, entity_type, entity_id, created_at desc);

-- Trigger genérico row-diff: compara to_jsonb(old) vs to_jsonb(new) y anota un
-- renglón por campo cambiado. Excluye timestamps de sistema y columnas generadas.
create or replace function audit_row_changes()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_company uuid;
  v_skip text[] := array['created_at', 'updated_at', 'signed_amount'];
begin
  if tg_op = 'INSERT' then
    v_company := (to_jsonb(new) ->> 'company_id')::uuid;
    insert into audit_log (company_id, entity_type, entity_id, field, old_value, new_value, actor_id, source)
    values (v_company, tg_table_name, new.id, '_created', null, null, auth.uid(),
            case when auth.uid() is null then 'system' else 'app' end);
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  v_company := (v_new ->> 'company_id')::uuid;

  for v_key in select jsonb_object_keys(v_new) loop
    if v_key = any (v_skip) then continue; end if;
    if v_old -> v_key is distinct from v_new -> v_key then
      insert into audit_log (company_id, entity_type, entity_id, field, old_value, new_value, actor_id, source)
      values (v_company, tg_table_name, new.id, v_key,
              v_old ->> v_key, v_new ->> v_key, auth.uid(),
              case when auth.uid() is null then 'system' else 'app' end);
    end if;
  end loop;
  return new;
end $$;

create trigger movements_audit
  after insert or update on movements
  for each row execute function audit_row_changes();
create trigger accounts_audit
  after insert or update on accounts
  for each row execute function audit_row_changes();
create trigger categories_audit
  after insert or update on categories
  for each row execute function audit_row_changes();
create trigger counterparties_audit
  after insert or update on counterparties
  for each row execute function audit_row_changes();

-- ---------- guard de movimientos importados/sincronizados ----------
-- Un movement con source ≠ manual es de solo lectura en sus campos monetarios:
-- la corrección se hace en la fuente (CRM/planilla) y el re-import la trae.
-- Localmente solo se puede reclasificar (categoría/contraparte/notas/meta).
create or replace function movements_guard()
returns trigger
language plpgsql
as $$
begin
  if private.is_system() then
    return new;
  end if;
  if old.source <> 'manual' then
    if new.amount      is distinct from old.amount
      or new.currency    is distinct from old.currency
      or new.account_id  is distinct from old.account_id
      or new.kind        is distinct from old.kind
      or new.occurred_on is distinct from old.occurred_on
      or new.external_key is distinct from old.external_key
      or new.source      is distinct from old.source then
      raise exception
        'movimiento de origen "%" — los campos monetarios se corrigen en la fuente, no acá',
        old.source;
    end if;
  end if;
  -- Nadie renombra el origen de un movimiento manual a otra cosa
  if old.source = 'manual' and new.source <> 'manual' then
    raise exception 'source es inmutable';
  end if;
  return new;
end $$;

create trigger movements_guard_trg
  before update on movements
  for each row execute function movements_guard();

-- ---------- documentos adjuntos ----------
create table documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies (id),
  -- bucket 'docs', path '<company_id>/<uuid>-<filename>'
  storage_path text not null,
  entity_type  text not null,
  entity_id    uuid not null,
  filename     text not null,
  mime         text,
  size_bytes   bigint,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  unique (id, company_id)
);

create index documents_entity_idx on documents (company_id, entity_type, entity_id);

-- Policies de Storage: solo si el schema storage existe (Supabase sí; un
-- Postgres pelado de test, no).
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute $pol$
      create policy docs_member_read on storage.objects for select to authenticated
        using (
          bucket_id = 'docs'
          and (storage.foldername(name))[1]::uuid in (select private.member_companies())
        )
    $pol$;
    execute $pol$
      create policy docs_member_write on storage.objects for insert to authenticated
        with check (
          bucket_id = 'docs'
          and (storage.foldername(name))[1]::uuid in (select private.member_companies())
        )
    $pol$;
  end if;
end $$;

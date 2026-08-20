-- 0008: defensa en profundidad con GRANTs. RLS ya decide fila por fila; esto
-- corta operaciones enteras que jamás deben llegar desde la API.

-- audit_log es append-only para TODOS los que vienen por la API.
revoke update, delete, truncate on audit_log from anon, authenticated;

-- La plata no se borra: void por update.
revoke delete, truncate on movements from anon, authenticated;
revoke delete, truncate on accounts from anon, authenticated;
revoke delete, truncate on categories from anon, authenticated;
revoke delete, truncate on counterparties from anon, authenticated;
revoke delete, truncate on companies from anon, authenticated;
revoke insert, update, delete, truncate on companies from anon, authenticated;
revoke insert, update, delete, truncate on memberships from anon, authenticated;
revoke delete, truncate on import_batches from anon, authenticated;
revoke delete, truncate on statement_lines from anon, authenticated;
revoke delete, truncate on documents from anon, authenticated;
revoke insert, update, delete, truncate on sync_runs from anon, authenticated;

-- anon no lee nada del dominio (la app siempre entra autenticada).
revoke all on all tables in schema public from anon;

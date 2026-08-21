-- Plata que entra a cuentas de KEEPSMILING (no del consultorio): Pancho no las
-- opera — la tiene que PEDIR. La UI marca estos movimientos para que se vea
-- de un vistazo qué parte de lo cobrado no está en su poder todavía.
alter table accounts add column ks_custody boolean not null default false;

update accounts set ks_custody = true
where name in ('Banco Macro', 'BBVA USD', 'Cuenta KS', 'Cuenta KS USD');

-- 0026: los pactos de cada paciente salen del código y entran a la base.
--
-- Hasta hoy, el precio pactado con un paciente, su plan de cuotas, su descuento
-- especial y el precio de su etapa adicional vivían en seis diccionarios de
-- lib/liquidaciones/pactos.ts. Cambiar cualquiera de esos números exigía editar
-- un archivo del repo, commitear y esperar un deploy: desde la página no había
-- ningún camino. Y son los números que deciden cuánto costo KS se le descuenta
-- a cada doctora, o sea plata.
--
-- La tabla treatment_plans ya existía (0011) con casi todo lo necesario. Acá se
-- le agregan las tres cosas que faltaban.

-- Descuento EXTRA sobre el costo KS de lista, en % (hoy 16% para tres casos con
-- descuento especial de fábrica). Va sobre el costo, no sobre lo que paga el
-- paciente: eso último es total_amount.
alter table treatment_plans
  add column ks_discount_pct numeric(5,2) check (ks_discount_pct >= 0 and ks_discount_pct < 100);

-- Precio DE LISTA propio del plan, para lo que no está en ks_price_list: hoy,
-- la etapa adicional de un tratamiento Medium ($498.000). El costeo le aplica
-- el mismo descuento de lista que a un tratamiento (40%) → $298.800 de costo.
-- Null en una etapa adicional significa "incluida en el programa 1 a 4": no
-- carga costo. Los dos casos existen y hay que poder distinguirlos.
alter table treatment_plans
  add column ks_list_price numeric(14,2) check (ks_list_price > 0);

-- Las otras grafías con las que ese paciente aparece en la caja.
--
-- POR QUÉ HACE FALTA. El costeo identifica al paciente por su nombre
-- normalizado (tokens ordenados, sin acentos), no por counterparty_id: la caja
-- del consultorio escribe el mismo paciente de varias formas y termina con
-- varias fichas. Martín Nisenbaum tiene TRES ("Martin Nissenbaum", "Nisenbaum
-- Martín", "Nisenbaum"), que normalizan a tres claves distintas. El diccionario
-- viejo resolvía esto repitiendo cada variante a mano; acá la variante es un
-- dato editable en vez de una línea de código.
alter table treatment_plans
  add column match_names text[] not null default '{}';

comment on column treatment_plans.match_names is
  'Otras grafías del paciente en la caja. El costeo matchea por nombre normalizado, no por id.';

create index treatment_plans_alineadores on treatment_plans (company_id, kind)
  where status = 'active';

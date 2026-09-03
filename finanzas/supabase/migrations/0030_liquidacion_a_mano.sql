-- 0030: poner una línea de la liquidación a mano, y poder volver atrás.
--
-- EL CASO QUE LO PIDIÓ. El 28/8/2026 Castiglioni Isabella abonó el tratamiento
-- entero: $3.638.700, motivo "Abona total tratamiento U$S 2600 con 10%
-- descuento". No tenía pacto cargado y el motivo no dice "cuota N de Y", así
-- que costearCuotas() no podía saber qué porcentaje del caso pagaba ese cobro:
-- lo dejaba SIN COSTEAR, con costo KS $0, y a Mónica se le liquidaba el 40% del
-- BRUTO — $655.440 de más en una sola línea. Esa causa puntual la arregla la
-- regla nueva del costeo ("paga el tratamiento entero" = 100% del caso), pero
-- abajo de ella quedaba el problema de fondo: cuando un número sale mal, la
-- única salida era cargar el pacto o tocar código y esperar un deploy.
--
-- POR QUÉ NO ALCANZA CON EDITAR settlement_items. La liquidación es un
-- artefacto DERIVADO: lib/liquidaciones/recalcular.ts recalcula el año entero
-- desde movements + settlement_imputations + treatment_plans y REESCRIBE
-- professional_settlements y settlement_items (borra los ítems del período y
-- los vuelve a insertar). Un número escrito ahí sobrevive hasta el próximo
-- recálculo — o sea, hasta que nadie lo esté mirando. Y el recálculo completo
-- no lo dispara sólo el botón "Recalcular": también guardarPacto() y cualquier
-- cambio en la lista de precios. Es el mismo razonamiento de la 0022 con el
-- importador de la caja, con otro reescritor: la corrección tiene que vivir en
-- una capa que el MOTOR lea, no en su salida.
--
-- POR QUÉ TAMPOCO SE CORRIGE EL MOVIMIENTO. La caja de Claudia se importa con
-- external_key de CONTENIDO, y desde la 0005 un movimiento de origen 'import' /
-- 'seed' / 'crm_sync' se corrige EN LA FUENTE (si no, el próximo sync pisa la
-- corrección). Además acá no se está corrigiendo lo que pasó —esa plata entró,
-- y entró así— sino cómo entra a la liquidación de la doctora. Son dos verdades
-- distintas y cada una tiene su tabla.
--
-- QUÉ NO ESTÁ ACÁ, a propósito: una tabla de ajustes sueltos (una línea que no
-- es ningún movimiento). Agregarle una línea a una liquidación ya tiene camino
-- y es el correcto: se carga el cobro en la caja —un movimiento manual, que es
-- por donde entra toda la plata de este sistema— y se le imputa la doctora con
-- la 0022. Un ajuste sin movimiento atrás rompería el PDF de la doctora (un
-- settlement_item necesita su movement_id) y pondría plata fuera del ledger,
-- que es la regla que sostiene todo lo demás. El día que aparezca un ajuste
-- real que no sea plata de la caja, se hace su migración con ese caso adelante.

-- ===========================================================================
-- Corregir una línea: settlement_line_overrides
-- ===========================================================================
--
-- La clave es el MOVIMIENTO, no el settlement_item: el ítem se borra y se
-- reinserta con id nuevo en cada recálculo, y el cobro además puede mudarse de
-- doctora por una imputación de la 0022. Lo único estable es el movimiento —
-- por eso settlement_items ya tiene unique (company_id, movement_id): un cobro
-- se liquida UNA vez, así que le corresponde UNA corrección.

create table settlement_line_overrides (
  -- id propio y no la PK natural movement_id, por lo mismo que la 0022: el
  -- trigger genérico de auditoría anota new.id y sin esta columna reventaría.
  id             uuid primary key default gen_random_uuid(),
  movement_id    uuid not null,
  company_id     uuid not null references companies (id),

  -- Los dos números que la doctora mira. NULL = "no lo toco, vale lo que
  -- calculó el motor", y es distinto de 0, que se escribe 0. Las dos cosas se
  -- pueden decir (la 0023 tuvo que desarmar justamente un NULL ambiguo).
  --
  -- collected_ars va SIEMPRE en pesos, como base_amount de settlement_items:
  -- desde el 25/8/26 la liquidación es un solo número en pesos y lo cobrado en
  -- dólares entra pesificado al blue de su fecha. Corregir acá es decir cuánto
  -- de ese cobro entra a la liquidación, no cuánto entró a la caja. Si lo que
  -- está mal es el t/c, eso se arregla en fx_rates.
  collected_ars  numeric(14,2) check (collected_ars >= 0),
  -- Costo KS de la línea, en pesos. El caso de Castiglioni es éste: el motor
  -- puso 0 y corresponde el costo completo del caso.
  ks_cost_ars    numeric(14,2) check (ks_cost_ars >= 0),

  -- OBLIGATORIO, y acá sí se aparta de la 0022 (donde reason es nullable): el
  -- destino de una imputación se explica solo ("casa", "caja", una doctora); un
  -- número escrito a mano, no. Dentro de tres meses la única forma de saber por
  -- qué esta línea dice lo que dice va a ser este campo.
  reason         text not null check (length(btrim(reason)) > 0),

  -- Lo que el cálculo decía cuando se escribió el número, y de qué cobro se
  -- trataba: { fecha, paciente, doctora, periodo, cobrado_calculado,
  -- costo_calculado, monto_caja, moneda }. Sirve para dos cosas: mostrar el
  -- "de → a" en el panel de cambios a mano sin volver a correr el motor (tarda
  -- ~3 segundos), y poder decir QUÉ se había corregido el día que la caja edite
  -- esa fila y el movimiento quede anulado.
  snapshot       jsonb not null default '{}',

  -- VOLVER ATRÁS es un update, no un delete. La 0022 borra sus correcciones y
  -- está bien: el destino de un cobro se vuelve a calcular solo. Un número no.
  -- Y hay un motivo técnico además del conceptual: audit_row_changes() (0005)
  -- no registra DELETE, y en el INSERT anota old_value/new_value en NULL — o
  -- sea que borrar deshace sin dejar rastro de que existió ni de cuánto decía.
  -- Un UPDATE de status sí queda anotado, con su valor viejo y el nuevo.
  status         text not null default 'active' check (status in ('active', 'void')),

  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  foreign key (movement_id, company_id) references movements (id, company_id),
  -- una línea, UNA corrección: la fila se reescribe, no se duplica. Deshacer y
  -- volver a corregir reusa la misma fila, y su historia queda en audit_log.
  unique (movement_id),
  -- Una fila que no corrige ninguno de los dos números no corrige nada: sería
  -- ruido en el panel y una decisión que no se puede deshacer porque no hizo
  -- nada. (Una corrección deshecha sí puede quedar con los dos en null.)
  constraint settlement_line_overrides_algo_corrige check (
    status = 'void' or collected_ars is not null or ks_cost_ars is not null
  )
);

comment on table settlement_line_overrides is
  'Corrección a mano de una línea de liquidación (un cobro): cuánto entra como cobrado y/o cuánto costó. La lee el motor en calcularTodo() ANTES de escribir settlement_items; sin eso el próximo recálculo la pisaría. Deshacer = status void.';
comment on column settlement_line_overrides.collected_ars is
  'Lo cobrado de esa línea, en PESOS. NULL = vale lo del cálculo. Poner 0 NO saca la línea: para eso está el destino "casa" de settlement_imputations (0022/0023).';
comment on column settlement_line_overrides.ks_cost_ars is
  'Costo KS de esa línea, en pesos. NULL = vale lo que calculó el costeo.';

create index settlement_line_overrides_company_idx
  on settlement_line_overrides (company_id, status);

create trigger settlement_line_overrides_updated_at
  before update on settlement_line_overrides for each row execute function set_updated_at();

-- ---------- guard: no se toca una línea de un mes cerrado ----------
-- Mismo chequeo que hace correct_movement() (0029) antes de dejar cambiar el
-- monto de un movimiento ya liquidado, y misma regla que imputarCobro(): una
-- liquidación confirmada o pagada es plata ya prometida. Para moverla está
-- reopen_settlement() (0027), que es la puerta que ya existe.
--
-- Vive en la base y no sólo en la server action porque la base es el único
-- lugar por el que pasan TODOS los caminos (la pantalla, un script, una
-- consulta a mano). Cubre también el "deshacer": sacar la corrección de una
-- liquidación cerrada le cambiaría el total igual que ponerla.
create or replace function settlement_line_overrides_guard()
returns trigger
language plpgsql
as $$
declare
  v_donde text;
begin
  -- Un override es de SU cobro: mudarlo de movimiento dejaría dos líneas
  -- corregidas con una sola fila de historial.
  if tg_op = 'UPDATE' and new.movement_id is distinct from old.movement_id then
    raise exception 'un override es de su cobro: para corregir otro, deshacé éste y creá el que va';
  end if;

  select s.period || ' ' || coalesce(c.display_name, 'esa doctora')
    into v_donde
    from settlement_items si
    join professional_settlements s on s.id = si.settlement_id
    left join counterparties c on c.id = s.professional_id
   where si.movement_id = new.movement_id
     and s.status in ('confirmed', 'paid')
   limit 1;

  if v_donde is not null then
    raise exception
      'ese cobro ya está liquidado en % y esa liquidación está cerrada: reabrila antes de tocar la línea',
      v_donde;
  end if;

  return new;
end $$;

create trigger settlement_line_overrides_guard_trg
  before insert or update on settlement_line_overrides
  for each row execute function settlement_line_overrides_guard();

-- ---------- RLS y grants (mismo criterio que la 0007/0010/0014/0022) ----------
alter table settlement_line_overrides enable row level security;

create policy settlement_line_overrides_select on settlement_line_overrides
  for select to authenticated
  using (company_id in (select private.member_companies()));

create policy settlement_line_overrides_insert on settlement_line_overrides
  for insert to authenticated
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

create policy settlement_line_overrides_update on settlement_line_overrides
  for update to authenticated
  using (private.has_role(company_id, array['owner', 'admin', 'operator']))
  with check (private.has_role(company_id, array['owner', 'admin', 'operator']));

-- Sin policy de DELETE: deshacer es status='void' (ver el comentario de la
-- columna). Lo que se escribió a mano no se borra sin dejar rastro.
grant select, insert, update on settlement_line_overrides to authenticated;
grant select, insert, update, delete on settlement_line_overrides to service_role;

-- quién cambió un número a mano importa tanto como el número
create trigger settlement_line_overrides_audit
  after insert or update on settlement_line_overrides
  for each row execute function audit_row_changes();

revoke all on settlement_line_overrides from anon;

-- ---------- el diagnóstico aprende a avisar del override colgado ----------
-- La external_key de la caja es de CONTENIDO: si Claudia edita esa fila, el
-- movimiento se anula, nace otro con otro id y la corrección deja de corregir.
-- Con las imputaciones eso se cuenta agregado ("N apuntan a movimientos que la
-- caja anuló"); con un NÚMERO no alcanza, porque al perderse la liquidación
-- vuelve sola al valor calculado y nadie se entera. Por eso el motor emite una
-- fila por override huérfano, con paciente, fecha y monto.
--
-- Sin este ALTER el insert del diagnóstico falla y se lleva puesto TODO el
-- recálculo: el CHECK de la 0025 sólo admite tres kinds.
alter table settlement_issues drop constraint settlement_issues_kind_check;
alter table settlement_issues add constraint settlement_issues_kind_check
  check (kind in ('sin_costear', 'imputacion_huerfana', 'cobro_trabado',
                  'override_huerfano'));

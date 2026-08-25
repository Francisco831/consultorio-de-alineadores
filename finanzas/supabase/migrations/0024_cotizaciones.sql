-- 0024: el tipo de cambio deja de ser un número escrito a mano en la caja.
--
-- Hasta hoy, cuando un cobro cruzaba de moneda el costeo leía el "t/c 1510" que
-- viniera escrito en el motivo, y si no había nada usaba una constante (1500).
-- Eso hacía que la misma plata valiera distinto según qué hubiera tipeado quien
-- cargó la fila, y que nadie pudiera reconstruir el número seis meses después.
--
-- Regla de Pancho (25/8/2026): se toma el dólar blue de la fecha del cobro,
-- promedio entre comprador y vendedor. Esta tabla es esa serie, guardada — no
-- consultada al vuelo — porque una liquidación tiene que dar lo mismo hoy que
-- el año que viene, y porque la fuente puede caerse justo cuando hay que
-- liquidar.
--
-- No tiene company_id a propósito: el dólar no es de una empresa.

create table fx_rates (
  source      text not null default 'ambito_informal',
  quote_date  date not null,
  buy         numeric(14,4) not null check (buy > 0),
  sell        numeric(14,4) not null check (sell > 0),
  -- El t/c efectivo. Generada para que ningún llamador pueda promediar distinto.
  rate        numeric(14,4) generated always as ((buy + sell) / 2) stored,
  fetched_at  timestamptz not null default now(),
  primary key (source, quote_date)
);

comment on table fx_rates is
  'Cotizaciones diarias del dólar. rate = (buy+sell)/2 es el t/c del sistema.';

create index fx_rates_fecha on fx_rates (quote_date desc);

alter table fx_rates enable row level security;

-- Lectura para cualquiera que esté logueado: no hay nada privado en el precio
-- del dólar, y filtrarlo por empresa obligaría a inventarle un dueño.
create policy fx_rates_select on fx_rates for select to authenticated using (true);

-- Escribe sólo el sync (service_role). Que la app no pueda tocar la serie es
-- justamente lo que hace reproducible una liquidación vieja.
grant select on fx_rates to authenticated;
grant select, insert, update, delete on fx_rates to service_role;

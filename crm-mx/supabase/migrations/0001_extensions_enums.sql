-- 0001: extensiones y enums
-- pg_trgm: búsqueda global por similitud de nombres
create extension if not exists pg_trgm;

create type doctor_categoria as enum (
  'SIN_CATEGORIA','SILVER','GOLD','PLATINUM','BLACK','ELITE'
);

create type lifecycle_stage as enum (
  'prospecto','acreditacion_pendiente','acreditado','acreditado_no_activado',
  'en_activacion','activo','growth','en_riesgo','dormido','perdido'
);

create type user_role as enum (
  'ADMIN','COUNTRY_MANAGER','SALES_MANAGER','SALES','CLINICAL','VIEWER'
);

create type opp_stage as enum (
  'paciente_potencial','documentacion','caso_ingresado','planificacion',
  'presentada','decision','compromiso','ganada','perdida'
);

create type forecast_cat as enum ('pipeline','best_case','commit','closed','omitted');

create type task_type as enum ('llamada','whatsapp','visita','reunion','revision_clinica','seguimiento');
create type task_status as enum ('pendiente','completada','cancelada');

-- 'keepday' = evento comercial mensual por asesor (métrica de comisiones LATAM 80/10/10)
create type activity_type as enum ('llamada','whatsapp','visita','reunion','revision_clinica','email','nota','keepday');

create type alert_status as enum ('abierta','descartada','resuelta');
create type alert_severity as enum ('critica','alta','media','info');

create type attribution_source as enum (
  'ventas','clinica','evento','curso','inbound','referido','existente','campana'
);

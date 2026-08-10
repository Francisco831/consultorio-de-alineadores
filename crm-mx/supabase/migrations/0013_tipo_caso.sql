-- 0013: tipo comercial del caso (Fast/Medium/Full/Kids/Teens) + alineadores
-- entregados, derivados de la ficha de entregas (FG Entregas MEXICO).
-- La columna "Etapa" de esa ficha mezcla el número de etapa (casos Full: 1.0/2.0/3.0)
-- con el producto (M=Medium, F=Fast, K1-K4=Kids, T1-T2=Teens) — validado por
-- cantidad de alineadores (F mediana 12 vs M mediana 18).
alter table cases
  add column if not exists tipo_caso text,
  add column if not exists alineadores_total int,
  add column if not exists entregas int;

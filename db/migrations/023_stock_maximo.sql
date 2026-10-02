-- 023: stock_maximo opcional en inventario. Sin dato, "Por pedir" sigue sugiriendo solo hasta
-- el minimo (comportamiento actual); con dato, sugiere completar hasta el maximo.
ALTER TABLE public.inventario
    ADD COLUMN IF NOT EXISTS stock_maximo numeric(10,3);

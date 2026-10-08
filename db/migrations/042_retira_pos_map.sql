BEGIN;

-- Toteat se retiró: el mapeo de nombres del POS externo a recetas (pos_map) solo servía para importar su CSV.
-- Las tablas venta_diaria / venta_diaria_detalle se CONSERVAN: guardan el historial de ventas ya importadas,
-- que Finanzas y «Ventas por receta» todavía leen.
DROP TABLE IF EXISTS public.pos_map;

COMMIT;

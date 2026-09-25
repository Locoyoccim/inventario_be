-- 018: IVA en precio de venta + merma de limpieza por insumo.
-- Sin BEGIN/COMMIT propios: el runner (db/migrate.js) envuelve cada archivo en su transacción.
-- Idempotente.

-- 1) empresas: IVA, si los precios incluyen IVA y food cost objetivo.
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS iva_pct numeric(5,2) NOT NULL DEFAULT 16;
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS precios_incluyen_iva boolean NOT NULL DEFAULT true;
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS food_cost_objetivo numeric(5,2) NOT NULL DEFAULT 30;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'empresas_iva_pct_check') THEN
        ALTER TABLE public.empresas ADD CONSTRAINT empresas_iva_pct_check CHECK (iva_pct >= 0 AND iva_pct <= 100);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'empresas_food_cost_objetivo_check') THEN
        ALTER TABLE public.empresas ADD CONSTRAINT empresas_food_cost_objetivo_check CHECK (food_cost_objetivo > 0 AND food_cost_objetivo < 100);
    END IF;
END $$;

-- 2) productos: merma de limpieza (%).
ALTER TABLE public.productos ADD COLUMN IF NOT EXISTS merma_pct numeric(5,2) NOT NULL DEFAULT 0;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'productos_merma_pct_check') THEN
        ALTER TABLE public.productos ADD CONSTRAINT productos_merma_pct_check CHECK (merma_pct >= 0 AND merma_pct < 90);
    END IF;
END $$;

-- 3) recetas: IVA por receta (backfill desde su empresa).
ALTER TABLE public.recetas ADD COLUMN IF NOT EXISTS iva_pct numeric(5,2) NOT NULL DEFAULT 16;
ALTER TABLE public.recetas ADD COLUMN IF NOT EXISTS precio_incluye_iva boolean NOT NULL DEFAULT true;
UPDATE public.recetas r
SET iva_pct = e.iva_pct, precio_incluye_iva = e.precios_incluyen_iva
FROM public.empresas e
WHERE r.empresa_id = e.id;

-- 4) Recrear margen sobre el precio SIN IVA (numeric(7,2) para no desbordar con margen negativo)
--    y agregar precio_neto y costo_pct como columnas GENERATED.
--    (Postgres no permite que una GENERATED referencie a otra, por eso cada una recalcula el neto inline.)
ALTER TABLE public.recetas DROP COLUMN IF EXISTS margen;
ALTER TABLE public.recetas DROP COLUMN IF EXISTS precio_neto;
ALTER TABLE public.recetas DROP COLUMN IF EXISTS costo_pct;

ALTER TABLE public.recetas ADD COLUMN precio_neto numeric(12,2) GENERATED ALWAYS AS (
    CASE WHEN precio_incluye_iva THEN precio_venta / (1 + iva_pct / 100) ELSE precio_venta END
) STORED;

ALTER TABLE public.recetas ADD COLUMN margen numeric(7,2) GENERATED ALWAYS AS (
    CASE WHEN precio_venta > 0
         THEN ((CASE WHEN precio_incluye_iva THEN precio_venta / (1 + iva_pct / 100) ELSE precio_venta END) - costo_total)
              / (CASE WHEN precio_incluye_iva THEN precio_venta / (1 + iva_pct / 100) ELSE precio_venta END) * 100
         ELSE 0 END
) STORED;

ALTER TABLE public.recetas ADD COLUMN costo_pct numeric(7,2) GENERATED ALWAYS AS (
    CASE WHEN precio_venta > 0
         THEN costo_total / (CASE WHEN precio_incluye_iva THEN precio_venta / (1 + iva_pct / 100) ELSE precio_venta END) * 100
         ELSE NULL END
) STORED;

BEGIN;

-- GAP-01: Preparaciones / subrecetas (Opción A).
-- Una receta puede marcarse como "preparación": además de ser receta, produce un
-- PRODUCTO ELABORADO que vive en inventario y puede ser ingrediente de otras recetas
-- (ej. una salsa que se usa en chilaquiles).
--
-- Costeo: el producto elaborado reutiliza la columna generada productos.costo_unitario.
--   cantidad_presentacion = rendimiento de la receta
--   costo_presentacion    = costo_total de la receta
--   => costo_unitario = costo_total / rendimiento  (costo por unidad de la preparación)

-- Enlace y metadatos en recetas
ALTER TABLE public.recetas
  ADD COLUMN IF NOT EXISTS es_preparacion boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rendimiento numeric(10,3) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS producto_elaborado_id integer REFERENCES public.productos(id);

-- Un producto elaborado pertenece a lo sumo a una receta
CREATE UNIQUE INDEX IF NOT EXISTS recetas_producto_elaborado_uidx
  ON public.recetas(producto_elaborado_id)
  WHERE producto_elaborado_id IS NOT NULL;

-- Distingue insumos comprados de productos elaborados internamente
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS es_elaborado boolean NOT NULL DEFAULT false;

COMMIT;

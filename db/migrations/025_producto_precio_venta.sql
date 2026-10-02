BEGIN;

-- Los productos mapeados como INSUMO en pos_map (se venden tal cual, sin receta) no tenían
-- ningún precio de venta en el sistema: el "ingreso esperado" de Finanzas solo usaba
-- recetas.precio_venta, así que esas líneas aportaban $0 al esperado aunque sí vendieran.
ALTER TABLE public.productos
    ADD COLUMN IF NOT EXISTS precio_venta numeric(10,2);

COMMIT;

BEGIN;

-- B-A3: proveedores con soft-delete (activo) y FKs que impiden el borrado físico.

-- 1) Columna activo (mismo patrón que productos.activo)
ALTER TABLE public.proveedores
    ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;

-- 2) Limpiar proveedor_id huérfanos antes de endurecer las FKs a RESTRICT
UPDATE public.productos p
    SET proveedor_id = NULL
    WHERE proveedor_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.proveedores pr WHERE pr.id = p.proveedor_id);

UPDATE public.compra c
    SET proveedor_id = NULL
    WHERE proveedor_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.proveedores pr WHERE pr.id = c.proveedor_id);

-- 3) productos.proveedor_id: SET NULL -> RESTRICT (no se borra un proveedor con productos)
ALTER TABLE public.productos DROP CONSTRAINT IF EXISTS inventario_proveedor_id_fkey;
ALTER TABLE public.productos
    ADD CONSTRAINT inventario_proveedor_id_fkey
    FOREIGN KEY (proveedor_id) REFERENCES public.proveedores(id) ON DELETE RESTRICT;

-- 4) compra.proveedor_id: FK nueva con RESTRICT (antes no existía)
ALTER TABLE public.compra DROP CONSTRAINT IF EXISTS compra_proveedor_id_fkey;
ALTER TABLE public.compra
    ADD CONSTRAINT compra_proveedor_id_fkey
    FOREIGN KEY (proveedor_id) REFERENCES public.proveedores(id) ON DELETE RESTRICT;

COMMIT;

BEGIN;

-- GAP front #2: soft-delete de productos. Un producto con historial (movimientos,
-- recetas) no puede borrarse por FKs; en su lugar se DESACTIVA (activo=false) y se
-- oculta de los listados por defecto.
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS productos_empresa_activo_idx ON public.productos(empresa_id, activo);

COMMIT;

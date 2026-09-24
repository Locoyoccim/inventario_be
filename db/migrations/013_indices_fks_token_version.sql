BEGIN;

-- A11: índices de apoyo. Las FKs sin índice provocan escaneos en joins y filtros por empresa.
CREATE INDEX IF NOT EXISTS receta_detalle_producto_idx ON public.receta_detalle(producto_id);
CREATE INDEX IF NOT EXISTS receta_detalle_receta_idx   ON public.receta_detalle(receta_id);
CREATE INDEX IF NOT EXISTS recetas_empresa_idx         ON public.recetas(empresa_id);
CREATE INDEX IF NOT EXISTS proveedores_empresa_idx     ON public.proveedores(empresa_id);
CREATE INDEX IF NOT EXISTS usuarios_empresa_idx        ON public.usuarios(empresa_id);

-- A11: llaves foráneas faltantes. Se limpian huérfanos nullable antes de endurecer.
UPDATE public.compra c SET usuario_id = NULL
    WHERE usuario_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.id = c.usuario_id);
ALTER TABLE public.compra DROP CONSTRAINT IF EXISTS compra_usuario_id_fkey;
ALTER TABLE public.compra ADD CONSTRAINT compra_usuario_id_fkey
    FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;

UPDATE public.conteo_fisico cf SET usuario_id = NULL
    WHERE usuario_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.id = cf.usuario_id);
ALTER TABLE public.conteo_fisico DROP CONSTRAINT IF EXISTS conteo_fisico_usuario_id_fkey;
ALTER TABLE public.conteo_fisico ADD CONSTRAINT conteo_fisico_usuario_id_fkey
    FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;

ALTER TABLE public.conteo_fisico DROP CONSTRAINT IF EXISTS conteo_fisico_empresa_id_fkey;
ALTER TABLE public.conteo_fisico ADD CONSTRAINT conteo_fisico_empresa_id_fkey
    FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;

-- producto_id es NOT NULL y los productos solo se desactivan (nunca se borran): RESTRICT.
ALTER TABLE public.conteo_detalle DROP CONSTRAINT IF EXISTS conteo_detalle_producto_id_fkey;
ALTER TABLE public.conteo_detalle ADD CONSTRAINT conteo_detalle_producto_id_fkey
    FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE RESTRICT;

-- A11: codigo_ingreso debe ser único POR EMPRESA (antes era único global: bug multi-tenant).
ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_codigo_ingreso_key;
ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_empresa_codigo_key;
ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_empresa_codigo_key
    UNIQUE (empresa_id, codigo_ingreso);

-- A10: versión de token para revocar sesiones (logout-all / cierre forzado por admin).
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

COMMIT;

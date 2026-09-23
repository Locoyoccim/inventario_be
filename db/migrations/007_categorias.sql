BEGIN;

-- Decisión de producto: categorías como LISTA COMPARTIDA administrable (una sola lista
-- para productos y recetas). El front la usa para poblar un selector consistente.
-- productos/recetas conservan su columna 'categoria' de texto (no se rompe data existente);
-- esta tabla es la fuente del selector.
CREATE TABLE IF NOT EXISTS public.categorias (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    nombre varchar(50) NOT NULL,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT categorias_empresa_nombre_uidx UNIQUE (empresa_id, nombre)
);

-- Semilla: categorías ya usadas hoy en productos y recetas.
INSERT INTO public.categorias (empresa_id, nombre)
SELECT DISTINCT empresa_id, categoria FROM public.productos
  WHERE empresa_id IS NOT NULL AND categoria IS NOT NULL AND btrim(categoria) <> ''
UNION
SELECT DISTINCT empresa_id, categoria FROM public.recetas
  WHERE empresa_id IS NOT NULL AND categoria IS NOT NULL AND btrim(categoria) <> ''
ON CONFLICT (empresa_id, nombre) DO NOTHING;

COMMIT;

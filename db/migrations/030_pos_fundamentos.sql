BEGIN;

-- Áreas de preparación: a dónde se imprime la comanda de cada platillo o bebida (Cocina,
-- Barra...). imprime=false es "Sin comanda": lo que el mesero sirve directo.
CREATE TABLE IF NOT EXISTS public.areas_preparacion (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    nombre varchar(60) NOT NULL,
    imprime boolean NOT NULL DEFAULT true,
    es_default boolean NOT NULL DEFAULT false,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT areas_preparacion_empresa_nombre_uk UNIQUE (empresa_id, nombre)
);
CREATE UNIQUE INDEX IF NOT EXISTS areas_preparacion_default_uidx ON public.areas_preparacion (empresa_id) WHERE es_default;

-- Resolución del área de un artículo: propio -> categoría -> área por defecto de la empresa.
ALTER TABLE public.categorias ADD COLUMN IF NOT EXISTS area_id integer REFERENCES public.areas_preparacion(id) ON DELETE SET NULL;
ALTER TABLE public.recetas ADD COLUMN IF NOT EXISTS area_id integer REFERENCES public.areas_preparacion(id) ON DELETE SET NULL;
ALTER TABLE public.productos ADD COLUMN IF NOT EXISTS area_id integer REFERENCES public.areas_preparacion(id) ON DELETE SET NULL;

INSERT INTO public.areas_preparacion (empresa_id, nombre, imprime, es_default)
SELECT e.id, v.nombre, v.imprime, v.es_default
FROM public.empresas e
CROSS JOIN (VALUES ('Cocina', true, true), ('Barra', true, false), ('Sin comanda', false, false)) AS v(nombre, imprime, es_default)
ON CONFLICT (empresa_id, nombre) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.mesas (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    nombre varchar(40) NOT NULL,
    zona varchar(60),
    capacidad integer NOT NULL DEFAULT 4,
    orden integer NOT NULL DEFAULT 0,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT mesas_empresa_nombre_uk UNIQUE (empresa_id, nombre),
    CONSTRAINT mesas_capacidad_check CHECK (capacidad > 0)
);
CREATE INDEX IF NOT EXISTS mesas_empresa_idx ON public.mesas (empresa_id, orden);

-- Permisos del POS (catálogo de 027/029). pos.ver: mapa de mesas en solo lectura.
CREATE OR REPLACE FUNCTION pg_temp.agregar_permisos(p_clave text, p_nuevos jsonb) RETURNS void AS $$
    UPDATE public.roles
    SET permisos = (SELECT COALESCE(jsonb_agg(DISTINCT x ORDER BY x), '[]'::jsonb)
                    FROM jsonb_array_elements_text(permisos || p_nuevos) AS x)
    WHERE clave = p_clave;
$$ LANGUAGE sql;

SELECT pg_temp.agregar_permisos('mesero', '["pos.ver","pos.ordenar"]');
SELECT pg_temp.agregar_permisos('cajero', '["pos.ver","pos.ordenar","pos.cobrar"]');
SELECT pg_temp.agregar_permisos('supervisor', '["pos.ver","pos.ordenar","pos.cobrar","pos.autorizar"]');
SELECT pg_temp.agregar_permisos('hostess', '["pos.ver"]');
SELECT pg_temp.agregar_permisos('recepcion', '["pos.ver"]');

COMMIT;

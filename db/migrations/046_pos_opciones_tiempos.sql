BEGIN;

-- Opciones por producto (término de la carne, extras, «sin ingrediente»…): grupos con sus opciones, que cada negocio arma y asigna
-- a sus recetas o productos. Una opción puede cobrar un extra y/o descontar un insumo del inventario al cobrar.
CREATE TABLE IF NOT EXISTS public.modificador_grupos (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    nombre character varying(60) NOT NULL,
    -- Cuántas opciones del grupo hay que elegir como mínimo (0 = opcional) y como máximo.
    minimo smallint NOT NULL DEFAULT 0,
    maximo smallint NOT NULL DEFAULT 1,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT modificador_grupos_limites_check CHECK (minimo >= 0 AND maximo >= 1 AND maximo <= 20 AND minimo <= maximo)
);
CREATE UNIQUE INDEX IF NOT EXISTS modificador_grupos_nombre_uk ON public.modificador_grupos (empresa_id, lower(nombre)) WHERE activo;

CREATE TABLE IF NOT EXISTS public.modificadores (
    id serial PRIMARY KEY,
    grupo_id integer NOT NULL REFERENCES public.modificador_grupos(id) ON DELETE CASCADE,
    nombre character varying(60) NOT NULL,
    precio_extra numeric(10,2) NOT NULL DEFAULT 0,
    -- Insumo que se descuenta al cobrar (por cada pieza del renglón) y cuánto.
    producto_id integer REFERENCES public.productos(id),
    cantidad numeric(12,3),
    orden smallint NOT NULL DEFAULT 0,
    activo boolean NOT NULL DEFAULT true,
    CONSTRAINT modificadores_extra_check CHECK (precio_extra >= 0),
    CONSTRAINT modificadores_consumo_check CHECK ((producto_id IS NULL AND cantidad IS NULL) OR (producto_id IS NOT NULL AND cantidad > 0))
);
CREATE INDEX IF NOT EXISTS modificadores_grupo_idx ON public.modificadores (grupo_id, orden);

-- A qué artículos se les ofrece cada grupo.
CREATE TABLE IF NOT EXISTS public.articulo_modificadores (
    id serial PRIMARY KEY,
    grupo_id integer NOT NULL REFERENCES public.modificador_grupos(id) ON DELETE CASCADE,
    receta_id integer REFERENCES public.recetas(id) ON DELETE CASCADE,
    producto_id integer REFERENCES public.productos(id) ON DELETE CASCADE,
    CONSTRAINT articulo_modificadores_uno_check CHECK ((receta_id IS NULL) <> (producto_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS articulo_modificadores_receta_uk ON public.articulo_modificadores (receta_id, grupo_id) WHERE receta_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS articulo_modificadores_producto_uk ON public.articulo_modificadores (producto_id, grupo_id) WHERE producto_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS articulo_modificadores_grupo_idx ON public.articulo_modificadores (grupo_id);

-- Renglones: las opciones elegidas quedan COPIADAS (nombre, extra e insumo) para que cambiar el catálogo no altere cuentas ya tomadas;
-- comensal (a quién se le sirve) y tiempo (1 = ahora, 2 = después de la entrada…).
ALTER TABLE public.pos_cuenta_items ADD COLUMN IF NOT EXISTS opciones jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.pos_cuenta_items ADD COLUMN IF NOT EXISTS comensal smallint;
ALTER TABLE public.pos_cuenta_items ADD COLUMN IF NOT EXISTS tiempo smallint NOT NULL DEFAULT 1;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_items_tiempo_check') THEN
        ALTER TABLE public.pos_cuenta_items ADD CONSTRAINT pos_items_tiempo_check CHECK (tiempo BETWEEN 1 AND 6);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_items_comensal_check') THEN
        ALTER TABLE public.pos_cuenta_items ADD CONSTRAINT pos_items_comensal_check CHECK (comensal IS NULL OR comensal BETWEEN 1 AND 99);
    END IF;
END $$;

COMMIT;

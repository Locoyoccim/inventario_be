BEGIN;

-- productos.categoria / recetas.categoria son texto libre (decisión de 007_categorias.sql,
-- para no romper datos existentes al introducir la tabla categorias). Nada impide hoy que un
-- producto/receta quede con una categoria que no existe en el catálogo administrable: datos
-- legacy de antes de 007, un INSERT directo, o una categoria que se borró por fuera de la app.
-- Esta migración cierra ese hueco en dos pasos: (1) backfill de cualquier categoria huérfana
-- hacia la tabla categorias, y (2) un trigger que a partir de ahora exige que toda categoria
-- escrita en productos/recetas ya exista en categorias para esa empresa.

-- 1) Backfill: cualquier categoria en uso hoy que no esté en el catálogo, se agrega.
INSERT INTO public.categorias (empresa_id, nombre)
SELECT DISTINCT empresa_id, btrim(categoria) FROM public.productos
  WHERE empresa_id IS NOT NULL AND categoria IS NOT NULL AND btrim(categoria) <> ''
UNION
SELECT DISTINCT empresa_id, btrim(categoria) FROM public.recetas
  WHERE empresa_id IS NOT NULL AND categoria IS NOT NULL AND btrim(categoria) <> ''
ON CONFLICT (empresa_id, nombre) DO NOTHING;

-- 2) Trigger de validación referencial (BEFORE INSERT/UPDATE). Vacío/NULL se permite (hay
-- productos sin categoria asignada); no vacío exige una fila en categorias para esa empresa.
CREATE OR REPLACE FUNCTION public.fn_categoria_existe() RETURNS trigger AS $$
BEGIN
    IF NEW.categoria IS NOT NULL AND btrim(NEW.categoria) <> '' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.categorias
            WHERE empresa_id = NEW.empresa_id AND nombre = btrim(NEW.categoria)
        ) THEN
            RAISE EXCEPTION 'La categoría "%" no existe en el catálogo de la empresa %', NEW.categoria, NEW.empresa_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_productos_categoria_existe ON public.productos;
CREATE TRIGGER trg_productos_categoria_existe
    BEFORE INSERT OR UPDATE OF categoria, empresa_id ON public.productos
    FOR EACH ROW EXECUTE FUNCTION public.fn_categoria_existe();

DROP TRIGGER IF EXISTS trg_recetas_categoria_existe ON public.recetas;
CREATE TRIGGER trg_recetas_categoria_existe
    BEFORE INSERT OR UPDATE OF categoria, empresa_id ON public.recetas
    FOR EACH ROW EXECUTE FUNCTION public.fn_categoria_existe();

COMMIT;

-- 017: tipo de categoría + normalización de la lista compartida.
-- No lleva BEGIN/COMMIT: el runner (db/migrate.js) ya envuelve cada archivo en una transacción.

-- 1) Columna tipo (PRODUCTO | RECETA | AMBAS), default AMBAS.
ALTER TABLE public.categorias
    ADD COLUMN IF NOT EXISTS tipo varchar(10) NOT NULL DEFAULT 'AMBAS';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categorias_tipo_check') THEN
        ALTER TABLE public.categorias
            ADD CONSTRAINT categorias_tipo_check CHECK (tipo IN ('PRODUCTO','RECETA','AMBAS'));
    END IF;
END $$;

-- 2) Fusionar variantes que solo difieren en mayúsculas: se conserva la de menor id.
--    Primero se repuntan productos/recetas al nombre canónico (menor id por empresa+lower).
UPDATE public.productos p
SET categoria = canon.canon_nombre
FROM (
    SELECT c.empresa_id, c.nombre,
           first_value(c.nombre) OVER (PARTITION BY c.empresa_id, lower(c.nombre) ORDER BY c.id) AS canon_nombre
    FROM public.categorias c
) canon
WHERE p.empresa_id = canon.empresa_id
  AND btrim(p.categoria) = canon.nombre
  AND canon.nombre <> canon.canon_nombre;

UPDATE public.recetas r
SET categoria = canon.canon_nombre
FROM (
    SELECT c.empresa_id, c.nombre,
           first_value(c.nombre) OVER (PARTITION BY c.empresa_id, lower(c.nombre) ORDER BY c.id) AS canon_nombre
    FROM public.categorias c
) canon
WHERE r.empresa_id = canon.empresa_id
  AND btrim(r.categoria) = canon.nombre
  AND canon.nombre <> canon.canon_nombre;

-- Borrar las variantes no canónicas (deja solo la de menor id por empresa+lower(nombre)).
DELETE FROM public.categorias c
WHERE c.id <> (
    SELECT MIN(c2.id) FROM public.categorias c2
    WHERE c2.empresa_id = c.empresa_id AND lower(c2.nombre) = lower(c.nombre)
);

-- 3) Insertar nombres usados por productos/recetas que aún no existan (case-insensitive),
--    con tipo según su uso. Se colapsan variantes por mayúsculas (una fila por lower(nombre)).
INSERT INTO public.categorias (empresa_id, nombre, tipo)
SELECT g.empresa_id, g.nombre,
       CASE WHEN g.en_prod AND g.en_rec THEN 'AMBAS'
            WHEN g.en_prod THEN 'PRODUCTO'
            WHEN g.en_rec THEN 'RECETA'
            ELSE 'AMBAS' END
FROM (
    SELECT empresa_id, MIN(nombre) AS nombre, bool_or(en_prod) AS en_prod, bool_or(en_rec) AS en_rec
    FROM (
        SELECT empresa_id, btrim(categoria) AS nombre,
               bool_or(src = 'P') AS en_prod, bool_or(src = 'R') AS en_rec
        FROM (
            SELECT empresa_id, categoria, 'P' AS src FROM public.productos
              WHERE empresa_id IS NOT NULL AND btrim(COALESCE(categoria, '')) <> ''
            UNION ALL
            SELECT empresa_id, categoria, 'R' AS src FROM public.recetas
              WHERE empresa_id IS NOT NULL AND btrim(COALESCE(categoria, '')) <> ''
        ) x
        GROUP BY empresa_id, btrim(categoria)
    ) per_name
    GROUP BY empresa_id, lower(nombre)
) g
WHERE NOT EXISTS (
    SELECT 1 FROM public.categorias c
    WHERE c.empresa_id = g.empresa_id AND lower(c.nombre) = lower(g.nombre)
);

-- 4) Backfill de tipo por uso para todas las filas (idempotente: se re-deriva del uso).
UPDATE public.categorias c
SET tipo = t.nuevo
FROM (
    SELECT c2.id,
           CASE
               WHEN EXISTS (SELECT 1 FROM public.productos p WHERE p.empresa_id = c2.empresa_id AND lower(btrim(p.categoria)) = lower(c2.nombre))
                AND EXISTS (SELECT 1 FROM public.recetas  r WHERE r.empresa_id = c2.empresa_id AND lower(btrim(r.categoria)) = lower(c2.nombre))
               THEN 'AMBAS'
               WHEN EXISTS (SELECT 1 FROM public.productos p WHERE p.empresa_id = c2.empresa_id AND lower(btrim(p.categoria)) = lower(c2.nombre))
               THEN 'PRODUCTO'
               WHEN EXISTS (SELECT 1 FROM public.recetas r WHERE r.empresa_id = c2.empresa_id AND lower(btrim(r.categoria)) = lower(c2.nombre))
               THEN 'RECETA'
               ELSE 'AMBAS'
           END AS nuevo
    FROM public.categorias c2
) t
WHERE c.id = t.id AND c.tipo <> t.nuevo;

-- 5) Índice único case-insensitive (empresa_id, lower(nombre)).
CREATE UNIQUE INDEX IF NOT EXISTS categorias_empresa_lower_nombre_uidx
    ON public.categorias (empresa_id, lower(nombre));

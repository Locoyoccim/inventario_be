-- 019: normaliza productos.unidad_medida a la forma canónica.
-- (La unidad de una preparación vive en su producto elaborado, también en productos.unidad_medida.)
-- Canónicas: g, kg, ml, l, pieza, porcion. Solo normaliza la ETIQUETA; no convierte cantidades.
-- Las variantes no reconocidas se dejan intactas (la validación de la API guarda los datos nuevos).
-- Sin BEGIN/COMMIT: el runner (db/migrate.js) envuelve cada archivo en su transacción. Idempotente.

-- clave normalizada (minúsculas, sin acentos comunes, sin espacios de más) -> canónica
UPDATE public.productos p
SET unidad_medida = m.canon
FROM (VALUES
    ('g','g'),('gr','g'),('grs','g'),('grms','g'),('gramo','g'),('gramos','g'),
    ('kg','kg'),('kgs','kg'),('kilo','kg'),('kilos','kg'),('kilogramo','kg'),('kilogramos','kg'),
    ('ml','ml'),('mls','ml'),('mililitro','ml'),('mililitros','ml'),('cc','ml'),('c.c.','ml'),
    ('l','l'),('lt','l'),('lts','l'),('litro','l'),('litros','l'),
    ('pieza','pieza'),('piezas','pieza'),('pza','pieza'),('pzas','pieza'),('pz','pieza'),('pzs','pieza'),
    ('unidad','pieza'),('unidades','pieza'),('u','pieza'),('und','pieza'),('uds','pieza'),('c/u','pieza'),('cu','pieza'),
    ('porcion','porcion'),('porciones','porcion'),('racion','porcion'),('raciones','porcion')
) AS m(variante, canon)
WHERE translate(lower(btrim(p.unidad_medida)), 'áéíóúü', 'aeiouu') = m.variante
  AND p.unidad_medida IS DISTINCT FROM m.canon;

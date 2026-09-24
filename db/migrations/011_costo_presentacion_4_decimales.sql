BEGIN;

-- B-A1: costo_presentacion pasa a numeric(12,4).
-- Motivo: en insumos con presentación chica (p.ej. cantidad_presentacion = 1) el
-- costo unitario real (ej. 0.0123) se perdía al redondear costo_presentacion a 2 dec.
-- costo_unitario es GENERATED y depende de costo_presentacion, y Postgres NO permite
-- ALTER TYPE sobre una columna usada por una columna generada
-- ("cannot alter type of a column used by a generated column").
-- Por eso: se quita la generada, se cambia el tipo, y se vuelve a crear idéntica.

ALTER TABLE public.productos DROP COLUMN costo_unitario;

ALTER TABLE public.productos
    ALTER COLUMN costo_presentacion TYPE numeric(12,4);

ALTER TABLE public.productos
    ADD COLUMN costo_unitario numeric(10,4)
    GENERATED ALWAYS AS ((costo_presentacion / cantidad_presentacion)) STORED;

COMMIT;

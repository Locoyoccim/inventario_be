BEGIN;

-- Descartar un trabajo de impresión que ya no hace falta (cola atorada, pruebas, comandas que se resolvieron de palabra). No se borra
-- la fila: un ticket descartado se puede volver a imprimir desde la cuenta y queda quién y cuándo lo descartó.
ALTER TABLE public.pos_impresiones
    ADD COLUMN IF NOT EXISTS descartada_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS descartada_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL;

ALTER TABLE public.pos_impresiones DROP CONSTRAINT IF EXISTS pos_impresiones_estado_check;
ALTER TABLE public.pos_impresiones
    ADD CONSTRAINT pos_impresiones_estado_check
    CHECK (estado IN ('PENDIENTE', 'IMPRIMIENDO', 'IMPRESO', 'ERROR', 'SIN_IMPRESORA', 'DESCARTADA'));

COMMIT;

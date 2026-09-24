BEGIN;

-- 2.1: anulación de compras (no se borra; se revierte el stock y se marca anulada).
ALTER TABLE public.compra
    ADD COLUMN IF NOT EXISTS anulado boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS anulado_at timestamptz,
    ADD COLUMN IF NOT EXISTS anulado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS motivo_anulacion text;

COMMIT;

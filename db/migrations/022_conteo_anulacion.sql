-- 022: anulacion de conteos fisicos, mismo patron que compra (015_compra_anulada.sql):
-- no se borra, se revierte el stock con un AJUSTE y se marca anulado con motivo.
ALTER TABLE public.conteo_fisico
    ADD COLUMN IF NOT EXISTS anulado boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS anulado_at timestamptz,
    ADD COLUMN IF NOT EXISTS anulado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS motivo_anulacion text;

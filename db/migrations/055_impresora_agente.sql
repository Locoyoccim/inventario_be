-- Afinidad impresora → agente: cada impresora puede asignarse al agente (PC) que la alcanza. NULL = cualquier agente de la
-- empresa (comportamiento anterior). Con varias PCs en la empresa evita que una reclame trabajos de impresoras que no ve.
ALTER TABLE public.impresoras
    ADD COLUMN IF NOT EXISTS agente_id integer REFERENCES public.agentes_impresion(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS impresoras_agente_idx ON public.impresoras (agente_id) WHERE agente_id IS NOT NULL;

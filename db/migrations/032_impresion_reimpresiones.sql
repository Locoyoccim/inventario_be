BEGIN;

-- Cada "Reimprimir" manual es una impresión nueva: el agente la distingue de la re-entrega de un
-- trabajo cuya confirmación se perdió (mismo id y mismo número de reimpresión = no se repite).
ALTER TABLE public.pos_impresiones ADD COLUMN IF NOT EXISTS reimpresiones integer NOT NULL DEFAULT 0;

COMMIT;

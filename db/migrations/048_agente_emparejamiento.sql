BEGIN;

-- Emparejamiento del agente de impresión por código (en lugar de copiar el token a mano). El Admin genera un código de un solo uso
-- (vence en 15 min; solo se guarda su hash); el instalador lo canjea y recibe un token nuevo, cuyo hash reemplaza al anterior.
ALTER TABLE public.agentes_impresion
    ADD COLUMN IF NOT EXISTS codigo_hash char(64),
    ADD COLUMN IF NOT EXISTS codigo_expira_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS equipo character varying(80),
    ADD COLUMN IF NOT EXISTS emparejado_at timestamp with time zone;

CREATE UNIQUE INDEX IF NOT EXISTS agentes_impresion_codigo_uk ON public.agentes_impresion (codigo_hash) WHERE codigo_hash IS NOT NULL;

COMMIT;

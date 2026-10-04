BEGIN;

-- Última actividad de una cuenta (capturar, enviar, cancelar, descontar, renombrar…). La mantienen triggers
-- para que ninguna ruta del POS se la salte; el mapa de mesas la muestra a meseros y supervisores.
ALTER TABLE public.pos_cuentas ADD COLUMN IF NOT EXISTS actualizada_at timestamptz;
UPDATE public.pos_cuentas SET actualizada_at = COALESCE(cerrada_at, abierta_at) WHERE actualizada_at IS NULL;
ALTER TABLE public.pos_cuentas ALTER COLUMN actualizada_at SET DEFAULT now();
ALTER TABLE public.pos_cuentas ALTER COLUMN actualizada_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.pos_cuenta_actualizada() RETURNS trigger AS $$
BEGIN
    NEW.actualizada_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pos_cuentas_actividad ON public.pos_cuentas;
CREATE TRIGGER pos_cuentas_actividad BEFORE UPDATE ON public.pos_cuentas
    FOR EACH ROW EXECUTE FUNCTION public.pos_cuenta_actualizada();

CREATE OR REPLACE FUNCTION public.pos_item_toca_cuenta() RETURNS trigger AS $$
BEGIN
    UPDATE public.pos_cuentas SET actualizada_at = now() WHERE id = COALESCE(NEW.cuenta_id, OLD.cuenta_id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pos_items_actividad ON public.pos_cuenta_items;
CREATE TRIGGER pos_items_actividad AFTER INSERT OR UPDATE OR DELETE ON public.pos_cuenta_items
    FOR EACH ROW EXECUTE FUNCTION public.pos_item_toca_cuenta();

COMMIT;

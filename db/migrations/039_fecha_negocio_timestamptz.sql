BEGIN;

-- Sobrecarga para columnas/expresiones con zona horaria (p. ej. el feed de Historial mezcla created_at,
-- anulado_at, etc. y Postgres lo unifica a timestamptz): el instante se convierte a la zona de la empresa.
CREATE OR REPLACE FUNCTION public.fecha_negocio(ts timestamp with time zone, tz text)
RETURNS date
LANGUAGE sql
STABLE
AS $$
    SELECT (ts AT TIME ZONE tz)::date
$$;

COMMIT;

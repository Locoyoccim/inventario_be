BEGIN;

-- Zona horaria de cada empresa (el sistema se vende a negocios de distintas regiones). Define qué día
-- es "hoy" y a qué día pertenece cada movimiento, sin depender de la zona del servidor de base de datos.
ALTER TABLE public.empresas
    ADD COLUMN IF NOT EXISTS zona_horaria character varying(64) NOT NULL DEFAULT 'America/Mexico_City';

-- movimientosinventario.fecha es "timestamp without time zone" con DEFAULT CURRENT_TIMESTAMP: guarda la
-- hora local de la SESIÓN de la base. Se interpreta en esa zona (current_setting) y se pasa a la de la
-- empresa. Así el día es el mismo en un servidor en UTC (p. ej. Railway) que en uno en hora de México.
CREATE OR REPLACE FUNCTION public.fecha_negocio(ts timestamp without time zone, tz text)
RETURNS date
LANGUAGE sql
STABLE
AS $$
    SELECT ((ts AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE tz)::date
$$;

COMMIT;

BEGIN;

-- AUD-011: el aviso de privacidad promete conservar la IP de la bitácora de acciones (admin_actividad) 12 meses como máximo.
-- La app (gh_app) no puede UPDATE esa tabla —es de solo inserción a propósito—, así que la purga es una función con los privilegios de
-- su dueño (el migrador) que hace UNA sola cosa: poner `ip = NULL` en lo que pasó de 12 meses. La fila, la acción, quién la hizo y
-- sobre qué se conservan (son la bitácora); solo se olvida desde dónde. Se programa con `npm run purgar:ips` (docs/OBSERVABILIDAD.md).
CREATE OR REPLACE FUNCTION public.purgar_ips_actividad() RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    n bigint;
BEGIN
    UPDATE public.admin_actividad
       SET ip = NULL
     WHERE ip IS NOT NULL
       AND creado_at < now() - interval '12 months';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.purgar_ips_actividad() FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gh_app') THEN
        GRANT EXECUTE ON FUNCTION public.purgar_ips_actividad() TO gh_app;
    END IF;
END
$$;

COMMIT;

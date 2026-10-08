BEGIN;

-- Una sola caja abierta por empresa a la vez. Antes bastaba con una por cajero, así que dos personas podían tener caja abierta
-- al mismo tiempo en el mismo negocio. Si ya hay empresas con varias abiertas, hay que cerrarlas desde Caja antes de migrar:
-- no se cierra nada solo (un cierre lleva su arqueo).
DO $$
DECLARE
    duplicadas text;
BEGIN
    SELECT string_agg(empresa_id::text || ' (' || n || ' abiertas)', ', ') INTO duplicadas
    FROM (SELECT empresa_id, COUNT(*) AS n FROM public.pos_turnos WHERE estado = 'ABIERTO' GROUP BY empresa_id HAVING COUNT(*) > 1) d;
    IF duplicadas IS NOT NULL THEN
        RAISE EXCEPTION 'Hay empresas con más de una caja abierta: %. Cierra las sobrantes desde Punto de venta > Caja y vuelve a migrar.', duplicadas;
    END IF;
END $$;

DROP INDEX IF EXISTS public.pos_turnos_abierto_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS pos_turnos_abierto_empresa_uidx ON public.pos_turnos (empresa_id) WHERE estado = 'ABIERTO';

COMMIT;

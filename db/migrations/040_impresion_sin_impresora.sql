BEGIN;

-- «Sin impresora configurada» no es una falla de impresión: es un negocio que aún no instala impresora
-- (o que imprime desde el navegador). Estado propio para no mezclarlo con los errores reales del agente.
ALTER TABLE public.pos_impresiones ALTER COLUMN estado TYPE character varying(20);
ALTER TABLE public.pos_impresiones DROP CONSTRAINT IF EXISTS pos_impresiones_estado_check;
ALTER TABLE public.pos_impresiones
    ADD CONSTRAINT pos_impresiones_estado_check
    CHECK (estado IN ('PENDIENTE', 'IMPRIMIENDO', 'IMPRESO', 'ERROR', 'SIN_IMPRESORA'));

UPDATE public.pos_impresiones
   SET estado = 'SIN_IMPRESORA'
 WHERE estado = 'ERROR' AND error LIKE 'Sin impresora configurada%';

COMMIT;

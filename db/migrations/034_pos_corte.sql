BEGIN;

-- Cierre de turno: lo que se entregó de propinas en efectivo (sale del cajón), quién cerró y la foto
-- de los totales al cerrar.
ALTER TABLE public.pos_turnos
    ADD COLUMN IF NOT EXISTS propinas_entregadas numeric(12,2) NOT NULL DEFAULT 0 CHECK (propinas_entregadas >= 0),
    ADD COLUMN IF NOT EXISTS nota_cierre varchar(200),
    ADD COLUMN IF NOT EXISTS cerrado_por integer REFERENCES public.usuarios(id),
    ADD COLUMN IF NOT EXISTS resumen jsonb;

-- Los ingresos que genera el corte quedan ligados al turno: trazabilidad y un solo ingreso por método y turno.
ALTER TABLE public.ingresos ADD COLUMN IF NOT EXISTS pos_turno_id integer REFERENCES public.pos_turnos(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ingresos_pos_turno_metodo_uidx ON public.ingresos (pos_turno_id, metodo_pago)
    WHERE pos_turno_id IS NOT NULL AND NOT anulado;

ALTER TABLE public.pos_impresiones DROP CONSTRAINT IF EXISTS pos_impresiones_tipo_check;
ALTER TABLE public.pos_impresiones ADD CONSTRAINT pos_impresiones_tipo_check CHECK (tipo IN ('COMANDA', 'PRECUENTA', 'TICKET', 'CORTE', 'PRUEBA'));

COMMIT;

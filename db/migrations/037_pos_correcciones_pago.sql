BEGIN;

-- Corrección del método o del monto de un pago ya cobrado (sin anular la cuenta). Guarda cómo estaba y cómo
-- quedó; si el corte del turno ya estaba cerrado, el cierre original no se toca y esto lo ajusta aparte.
CREATE TABLE IF NOT EXISTS public.pos_correcciones_pago (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    cuenta_id integer NOT NULL REFERENCES public.pos_cuentas(id) ON DELETE CASCADE,
    turno_id integer REFERENCES public.pos_turnos(id),
    turno_cerrado boolean NOT NULL DEFAULT false,
    motivo text NOT NULL,
    autorizado_por integer NOT NULL REFERENCES public.usuarios(id),
    solicitado_por integer REFERENCES public.usuarios(id),
    antes jsonb NOT NULL,
    despues jsonb NOT NULL,
    delta_efectivo numeric(12,2) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_correcciones_turno_idx ON public.pos_correcciones_pago (turno_id);
CREATE INDEX IF NOT EXISTS pos_correcciones_cuenta_idx ON public.pos_correcciones_pago (cuenta_id);

ALTER TABLE public.pos_autorizaciones DROP CONSTRAINT IF EXISTS pos_autorizaciones_tipo_check;
ALTER TABLE public.pos_autorizaciones ADD CONSTRAINT pos_autorizaciones_tipo_check
    CHECK (tipo IN ('DESCUENTO', 'CORTESIA', 'QUITAR_DESCUENTO', 'CANCELAR_ITEM', 'CANCELAR_CUENTA', 'ANULAR_CUENTA', 'CORREGIR_PAGO'));

COMMIT;

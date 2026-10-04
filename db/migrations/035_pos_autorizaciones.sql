BEGIN;

-- Bitácora de lo que requiere autorización de un supervisor: descuentos, cortesías, cancelaciones y anulaciones.
CREATE TABLE IF NOT EXISTS public.pos_autorizaciones (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    cuenta_id integer REFERENCES public.pos_cuentas(id) ON DELETE CASCADE,
    item_id integer,
    tipo varchar(20) NOT NULL,
    monto numeric(12,2) NOT NULL DEFAULT 0,
    motivo text,
    autorizado_por integer NOT NULL REFERENCES public.usuarios(id),
    solicitado_por integer REFERENCES public.usuarios(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pos_autorizaciones_tipo_check CHECK (tipo IN ('DESCUENTO', 'CORTESIA', 'QUITAR_DESCUENTO', 'CANCELAR_ITEM', 'CANCELAR_CUENTA', 'ANULAR_CUENTA'))
);
CREATE INDEX IF NOT EXISTS pos_autorizaciones_empresa_idx ON public.pos_autorizaciones (empresa_id, created_at);

-- Anular una cuenta cobrada: sus pagos quedan marcados (no cuentan como venta) y el dinero devuelto se
-- registra aparte, en el turno de quien lo entrega (el efectivo sale de ese cajón).
ALTER TABLE public.pos_pagos ADD COLUMN IF NOT EXISTS anulado boolean NOT NULL DEFAULT false;
ALTER TABLE public.pos_cuentas
    ADD COLUMN IF NOT EXISTS anulada_at timestamptz,
    ADD COLUMN IF NOT EXISTS anulada_por integer REFERENCES public.usuarios(id);

CREATE TABLE IF NOT EXISTS public.pos_devoluciones (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    cuenta_id integer NOT NULL REFERENCES public.pos_cuentas(id) ON DELETE CASCADE,
    pago_id integer REFERENCES public.pos_pagos(id) ON DELETE SET NULL,
    turno_id integer REFERENCES public.pos_turnos(id),
    metodo varchar(15) NOT NULL,
    monto numeric(12,2) NOT NULL,
    propina numeric(12,2) NOT NULL DEFAULT 0,
    usuario_id integer REFERENCES public.usuarios(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pos_devoluciones_metodo_check CHECK (metodo IN ('EFECTIVO', 'TARJETA', 'TRANSFERENCIA')),
    CONSTRAINT pos_devoluciones_importes_check CHECK (monto >= 0 AND propina >= 0)
);
CREATE INDEX IF NOT EXISTS pos_devoluciones_turno_idx ON public.pos_devoluciones (turno_id);

COMMIT;

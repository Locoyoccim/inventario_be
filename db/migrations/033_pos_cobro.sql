BEGIN;

-- Pagos de una cuenta (permite pago mixto). `monto` es lo que liquida la cuenta; la propina va aparte
-- y no es ingreso del negocio. En efectivo, `recibido` es lo que entregó el cliente y
-- cambio = recibido - monto - propina. Tarjeta (terminal externa) y transferencia no llevan recibido.
CREATE TABLE IF NOT EXISTS public.pos_pagos (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    cuenta_id integer NOT NULL REFERENCES public.pos_cuentas(id) ON DELETE CASCADE,
    turno_id integer NOT NULL REFERENCES public.pos_turnos(id),
    usuario_id integer REFERENCES public.usuarios(id),
    metodo varchar(15) NOT NULL,
    monto numeric(12,2) NOT NULL,
    propina numeric(12,2) NOT NULL DEFAULT 0,
    recibido numeric(12,2),
    cambio numeric(12,2),
    referencia varchar(40),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pos_pagos_metodo_check CHECK (metodo IN ('EFECTIVO', 'TARJETA', 'TRANSFERENCIA')),
    CONSTRAINT pos_pagos_importes_check CHECK (monto >= 0 AND propina >= 0 AND monto + propina > 0),
    CONSTRAINT pos_pagos_efectivo_check CHECK (
        (metodo = 'EFECTIVO' AND recibido IS NOT NULL AND cambio IS NOT NULL AND cambio >= 0 AND recibido = monto + propina + cambio)
        OR (metodo <> 'EFECTIVO' AND recibido IS NULL AND cambio IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS pos_pagos_cuenta_idx ON public.pos_pagos (cuenta_id);
CREATE INDEX IF NOT EXISTS pos_pagos_turno_idx ON public.pos_pagos (turno_id);

-- Importes congelados al cobrar (para reportes y corte sin recalcular renglones).
ALTER TABLE public.pos_cuentas
    ADD COLUMN IF NOT EXISTS subtotal numeric(12,2),
    ADD COLUMN IF NOT EXISTS descuento numeric(12,2),
    ADD COLUMN IF NOT EXISTS iva numeric(12,2),
    ADD COLUMN IF NOT EXISTS total numeric(12,2),
    ADD COLUMN IF NOT EXISTS propina numeric(12,2),
    ADD COLUMN IF NOT EXISTS cobrada_por integer REFERENCES public.usuarios(id);

COMMIT;

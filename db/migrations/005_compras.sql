BEGIN;

-- GAP-03: Compras (entrada de mercancía) con actualización de costo (ÚLTIMO COSTO).
-- Una compra suma stock (movimiento COMPRA) y actualiza el costo del producto al
-- precio de la última compra (costo de reposición).
-- Las LÍNEAS de la compra se guardan como movimientos COMPRA (referencia_tipo='COMPRA',
-- referencia_id = compra.id), que ya registran producto, cantidad, costo y stock antes/después.

CREATE TABLE IF NOT EXISTS public.compra (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    fecha date NOT NULL DEFAULT CURRENT_DATE,
    proveedor_id integer,
    referencia text,                 -- folio de factura / nota
    total numeric(12,2) NOT NULL DEFAULT 0,
    usuario_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS compra_empresa_fecha_idx ON public.compra(empresa_id, fecha);

COMMIT;

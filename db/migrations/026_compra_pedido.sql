-- Estado "pedido / recibido" en Compras: una compra registrada como PEDIDO no toca inventario
-- ni costo hasta que se confirma su recepcion. compra_detalle guarda las lineas de un pedido
-- mientras esta pendiente (una vez recibido, las lineas reales quedan en movimientosinventario,
-- igual que siempre; compra_detalle no se borra, queda como el registro de lo pedido).

ALTER TABLE compra ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'RECIBIDA';
ALTER TABLE compra ADD CONSTRAINT compra_estado_check CHECK (estado IN ('PEDIDO', 'RECIBIDA'));

CREATE TABLE IF NOT EXISTS compra_detalle (
    id serial PRIMARY KEY,
    compra_id integer NOT NULL REFERENCES compra(id) ON DELETE CASCADE,
    producto_id integer NOT NULL REFERENCES productos(id),
    cantidad numeric(14,3) NOT NULL,
    costo_unitario numeric(14,4) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compra_detalle_compra ON compra_detalle(compra_id);

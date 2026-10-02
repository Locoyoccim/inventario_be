BEGIN;

-- Cabecera de producción: hasta ahora cada "Confirmar" solo dejaba movimientosinventario
-- sueltos con referencia_id = receta_id, sin forma de aislar una corrida puntual de otra de
-- la misma receta. Con esta tabla, cada clic en "Confirmar" crea UN registro aquí y todos sus
-- movimientos (insumos consumidos + elaborado recibido, de todas las recetas de ese lote)
-- quedan referenciados a su id: igual que compra/conteo_fisico, permite anular esa corrida
-- puntual sin tocar otras producciones de la misma receta.
CREATE TABLE IF NOT EXISTS public.produccion (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    fecha date NOT NULL DEFAULT CURRENT_DATE,
    usuario_id integer,
    anulado boolean NOT NULL DEFAULT false,
    anulado_at timestamptz,
    anulado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    motivo_anulacion text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS produccion_empresa_fecha_idx ON public.produccion(empresa_id, fecha);

COMMIT;

BEGIN;

-- GAP-02: Conteo físico de inventario + varianza teórico vs. real.
-- El operador cuenta lo que físicamente hay; el sistema lo compara contra el stock
-- teórico, calcula la varianza (negativa = merma, positiva = sobrante) y reconcilia
-- el inventario aplicando movimientos AJUSTE. Queda historial para reportes.

CREATE TABLE IF NOT EXISTS public.conteo_fisico (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    fecha date NOT NULL DEFAULT CURRENT_DATE,
    usuario_id integer,
    motivo text,
    estado varchar(20) NOT NULL DEFAULT 'CERRADO',
    total_lineas integer NOT NULL DEFAULT 0,
    valor_variacion_total numeric(12,2) NOT NULL DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT conteo_fisico_estado_chk CHECK (estado = ANY (ARRAY['ABIERTO','CERRADO']))
);

CREATE TABLE IF NOT EXISTS public.conteo_detalle (
    id serial PRIMARY KEY,
    conteo_id integer NOT NULL REFERENCES public.conteo_fisico(id) ON DELETE CASCADE,
    producto_id integer NOT NULL,
    stock_teorico numeric(10,3) NOT NULL,
    stock_fisico numeric(10,3) NOT NULL,
    costo_unitario numeric(10,4) NOT NULL DEFAULT 0,
    variacion numeric(10,3) GENERATED ALWAYS AS (stock_fisico - stock_teorico) STORED,
    valor_variacion numeric(12,2) GENERATED ALWAYS AS ((stock_fisico - stock_teorico) * costo_unitario) STORED
);

CREATE INDEX IF NOT EXISTS conteo_detalle_conteo_idx ON public.conteo_detalle(conteo_id);
CREATE INDEX IF NOT EXISTS conteo_fisico_empresa_fecha_idx ON public.conteo_fisico(empresa_id, fecha);

COMMIT;

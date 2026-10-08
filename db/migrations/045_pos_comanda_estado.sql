BEGIN;

-- Pantalla de cocina (KDS) OPCIONAL: cada negocio decide si la usa. Apagada, todo funciona como antes (solo papel).
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS usa_pantalla_cocina boolean NOT NULL DEFAULT false;

-- Un área puede imprimir, mostrarse en pantalla o ambas (la pantalla solo cuenta si la empresa la tiene activada).
ALTER TABLE public.areas_preparacion ADD COLUMN IF NOT EXISTS pantalla boolean NOT NULL DEFAULT false;
-- Minutos que debería tardar una comanda de esta área; la pantalla cambia de color al pasarse.
ALTER TABLE public.areas_preparacion ADD COLUMN IF NOT EXISTS tiempo_objetivo_min smallint NOT NULL DEFAULT 15;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'areas_tiempo_objetivo_check') THEN
        ALTER TABLE public.areas_preparacion ADD CONSTRAINT areas_tiempo_objetivo_check CHECK (tiempo_objetivo_min BETWEEN 1 AND 240);
    END IF;
END $$;

-- Estado de cada comanda: NUEVA -> EN_PREPARACION -> LISTA -> ENTREGADA (o CANCELADA si se canceló todo lo que traía).
-- Las comandas de áreas sin pantalla nacen ENTREGADA: nadie las va a marcar y no deben aparecer como pendientes.
ALTER TABLE public.pos_comandas ADD COLUMN IF NOT EXISTS estado character varying(16) NOT NULL DEFAULT 'NUEVA';
ALTER TABLE public.pos_comandas ADD COLUMN IF NOT EXISTS en_preparacion_at timestamptz;
ALTER TABLE public.pos_comandas ADD COLUMN IF NOT EXISTS lista_at timestamptz;
ALTER TABLE public.pos_comandas ADD COLUMN IF NOT EXISTS entregada_at timestamptz;
ALTER TABLE public.pos_comandas ADD COLUMN IF NOT EXISTS actualizada_at timestamptz NOT NULL DEFAULT now();
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_comandas_estado_check') THEN
        -- Las existentes (anteriores a la pantalla) se dan por entregadas antes de exigir el valor.
        UPDATE public.pos_comandas SET estado = 'ENTREGADA';
        ALTER TABLE public.pos_comandas ADD CONSTRAINT pos_comandas_estado_check CHECK (estado IN ('NUEVA','EN_PREPARACION','LISTA','ENTREGADA','CANCELADA'));
    END IF;
END $$;
-- La pantalla consulta lo activo por empresa y área.
CREATE INDEX IF NOT EXISTS pos_comandas_activas_idx ON public.pos_comandas (empresa_id, area_id, estado) WHERE estado IN ('NUEVA','EN_PREPARACION','LISTA');

-- Permiso para marcar «preparando/lista» y rol del personal de cocina y barra.
CREATE OR REPLACE FUNCTION pg_temp.agregar_permisos(p_clave text, p_nuevos jsonb) RETURNS void AS $$
    UPDATE public.roles
    SET permisos = (SELECT COALESCE(jsonb_agg(DISTINCT x ORDER BY x), '[]'::jsonb)
                    FROM jsonb_array_elements_text(permisos || p_nuevos) AS x)
    WHERE clave = p_clave;
$$ LANGUAGE sql;

INSERT INTO public.roles (nombre, descripcion, clave, permisos) VALUES
    ('Cocina / Barra', 'Ve las comandas de su área en la pantalla de cocina y las marca como preparando y listas.', 'cocina', '["pos.ver","pos.preparar"]'::jsonb)
ON CONFLICT (clave) DO NOTHING;
SELECT pg_temp.agregar_permisos('supervisor', '["pos.preparar"]');

COMMIT;

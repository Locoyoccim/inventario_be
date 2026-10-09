BEGIN;

-- Bitácora de acciones administrativas (Fase 6, ADR-009): quién cambió qué, cuándo y desde dónde. Solo se INSERTA y se LEE: la app (gh_app)
-- no puede actualizar ni borrar filas, así que una persona con acceso a la aplicación —o un fallo de la propia aplicación— no puede
-- reescribir lo que quedó registrado.
--
-- Sin claves foráneas a propósito: la bitácora debe sobrevivir a que se borre una empresa o un usuario (y las FK con ON DELETE
-- obligarían a modificar o borrar filas de un registro de solo inserción). `empresa_id` es la empresa AFECTADA por la acción;
-- `actor_empresa_id` es la empresa activa de la sesión de quien la hizo (distinta cuando actúa el maestro o con acceso compartido).
-- Los secretos (contraseñas, PIN, tokens, códigos) nunca van en `detalle`: solo ids, nombres de campos y banderas.
CREATE TABLE IF NOT EXISTS public.admin_actividad (
    id bigserial PRIMARY KEY,
    creado_at timestamp with time zone NOT NULL DEFAULT now(),
    empresa_id integer NOT NULL,
    actor_id integer,
    actor_empresa_id integer,
    accion text NOT NULL,
    objeto_tipo text NOT NULL,
    objeto_id integer,
    detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip text,
    request_id text,
    CONSTRAINT admin_actividad_accion_chk CHECK (accion ~ '^[a-z_]+\.[a-z_]+$'),
    CONSTRAINT admin_actividad_detalle_chk CHECK (jsonb_typeof(detalle) = 'object' AND pg_column_size(detalle) <= 8192)
);
CREATE INDEX IF NOT EXISTS admin_actividad_empresa_idx ON public.admin_actividad (empresa_id, creado_at DESC);
CREATE INDEX IF NOT EXISTS admin_actividad_actor_idx ON public.admin_actividad (actor_id, creado_at DESC) WHERE actor_id IS NOT NULL;

-- Solo inserción para la app. Los permisos por defecto del migrador le dan SELECT/INSERT/UPDATE/DELETE a las tablas nuevas; aquí se le
-- quitan los dos últimos. (scripts/db_roles.js repite esto al provisionar: una concesión general no debe devolvérselos.)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gh_app') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON public.admin_actividad FROM gh_app;
    END IF;
END
$$;

COMMIT;

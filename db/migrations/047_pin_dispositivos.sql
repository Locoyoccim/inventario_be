BEGIN;

-- PIN corto para entrar rápido desde un equipo registrado (el celular del mesero). El PIN nunca se guarda en claro ni
-- vale por sí solo: solo funciona desde un equipo que un Admin registró, y no aplica a dueño/administradores.
ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS pin_hash text,
    ADD COLUMN IF NOT EXISTS pin_actualizado_at timestamp with time zone,
    -- Bloqueo duro tras demasiados fallos acumulados: solo un Admin lo quita (o definir un PIN nuevo).
    ADD COLUMN IF NOT EXISTS pin_bloqueado_at timestamp with time zone;

-- Equipos registrados. El Admin crea el equipo y obtiene un código de un solo uso; quien lo escribe en el equipo recibe un
-- token (cookie httpOnly) y desde ahí se entra con PIN. En la BD solo quedan los hashes del código y del token.
CREATE TABLE IF NOT EXISTS public.dispositivos (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL REFERENCES public.empresas(id),
    nombre character varying(80) NOT NULL,
    codigo_hash character(64),
    codigo_expira_at timestamp with time zone,
    token_hash character(64),
    activo boolean NOT NULL DEFAULT true,
    activado_at timestamp with time zone,
    ultimo_uso timestamp with time zone,
    creado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    revocado_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT dispositivos_codigo_uk UNIQUE (codigo_hash),
    CONSTRAINT dispositivos_token_uk UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS dispositivos_empresa_idx ON public.dispositivos (empresa_id);

-- Intentos fallidos de PIN: de aquí salen el enfriamiento por (usuario, equipo), por equipo, por IP y el bloqueo duro.
CREATE TABLE IF NOT EXISTS public.pin_fallos (
    id bigserial PRIMARY KEY,
    empresa_id integer NOT NULL,
    usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    dispositivo_id integer NOT NULL REFERENCES public.dispositivos(id) ON DELETE CASCADE,
    ip text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pin_fallos_usuario_idx ON public.pin_fallos (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pin_fallos_dispositivo_idx ON public.pin_fallos (dispositivo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pin_fallos_ip_idx ON public.pin_fallos (ip, created_at DESC);

COMMIT;

BEGIN;

-- Enlaces de un solo uso para que una persona defina su contraseña (invitación de un owner nuevo; después,
-- recuperación). Solo se guarda el hash del token: quien lea la base no puede activar cuentas.
CREATE TABLE IF NOT EXISTS public.usuario_tokens (
    id serial PRIMARY KEY,
    usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    tipo character varying(20) NOT NULL,
    token_hash character(64) NOT NULL,
    expira_at timestamp with time zone NOT NULL,
    usado_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT usuario_tokens_tipo_check CHECK (tipo IN ('INVITACION', 'RECUPERACION')),
    CONSTRAINT usuario_tokens_hash_uk UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS usuario_tokens_usuario_idx ON public.usuario_tokens (usuario_id, tipo);

COMMIT;

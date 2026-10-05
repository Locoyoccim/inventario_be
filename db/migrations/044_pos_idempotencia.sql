BEGIN;

-- Llaves de idempotencia del POS: un reintento (por una señal que se cortó, o un doble toque) con la misma llave
-- devuelve lo que ya se hizo en lugar de repetirlo. La llave se reserva DENTRO de la misma transacción que el efecto
-- (abrir cuenta, agregar, enviar, cobrar): o se confirma todo junto o no queda nada. `status` 0 = reservada, aún sin
-- respuesta guardada (la operación se está terminando de responder).
CREATE TABLE IF NOT EXISTS public.pos_idempotencia (
    empresa_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    usuario_id integer NOT NULL,
    clave character varying(80) NOT NULL,
    endpoint character varying(160) NOT NULL,
    req_hash character(64) NOT NULL,
    status smallint NOT NULL DEFAULT 0,
    respuesta jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (empresa_id, usuario_id, clave, endpoint)
);
-- Para la purga de llaves viejas (se conservan 48 h).
CREATE INDEX IF NOT EXISTS pos_idempotencia_created_idx ON public.pos_idempotencia (created_at);

COMMIT;

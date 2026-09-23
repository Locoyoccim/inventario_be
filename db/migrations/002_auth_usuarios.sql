-- Auth: correo y hash de contraseña para login
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Correo único solo cuando está presente (los usuarios viejos pueden no tenerlo aún)
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_unique
    ON usuarios (email) WHERE email IS NOT NULL;

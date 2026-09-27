-- Bug multi-tenant: usuarios_email_unique era único GLOBAL, no por empresa.
-- Dos empresas distintas no podían usar el mismo correo, y crear_admin.js hacía
-- ON CONFLICT (email) DO UPDATE, lo que permitía que un admin nuevo de la
-- Empresa B "adoptara" y sobrescribiera la fila de un usuario de la Empresa A
-- si el correo coincidía (toma de identidad entre tenants).
DROP INDEX IF EXISTS usuarios_email_unique;

-- Correo único solo cuando está presente, ahora ámbito por empresa: sigue
-- sirviendo para el lookup de login (empresa_id + email) sin bloquear el
-- mismo correo entre empresas distintas.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_empresa_email_unique
    ON usuarios (empresa_id, email) WHERE email IS NOT NULL;

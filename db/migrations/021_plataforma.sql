-- Capa de plataforma: un usuario maestro puede dar de alta empresas nuevas (con su primer
-- Owner) sin pasar por /auth/setup, que solo funciona una vez en toda la base.

-- Revierte 020: el correo vuelve a ser único GLOBAL. AuthService.login busca por correo sin
-- filtrar por empresa (SELECT_BY_EMAIL no recibe empresa_id) y no sabe desambiguar cuando el
-- mismo correo existe en dos empresas distintas; con varias empresas activas eso ya puede pasar.
DROP INDEX IF EXISTS usuarios_empresa_email_unique;
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_unique
    ON usuarios (email) WHERE email IS NOT NULL;

-- Usuario maestro de plataforma: puede crear empresas nuevas (con su primer Owner),
-- activarlas/desactivarlas y resetear la contraseña de un Owner. Sigue siendo un usuario
-- normal (Owner/Admin) de su propia empresa además de maestro; no ve los datos operativos
-- de las demás empresas.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

-- Contraseña temporal: al crear el Owner de una empresa nueva (o resetear la contraseña de
-- uno existente), el maestro define una contraseña temporal y el usuario debe cambiarla antes
-- de usar el resto de la API (bloqueo en requirePasswordCurrent, ver activeUser.js).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Empresas activas/inactivas: el maestro puede desactivar un tenant (bloquea el login y toda
-- la API para todos sus usuarios, igual que desactivar a un usuario individual) sin borrar
-- sus datos.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Marca la cuenta existente (Carlos, Café Aroma) como usuario maestro de plataforma.
UPDATE usuarios SET is_platform_admin = true WHERE lower(email) = lower('carlos@cafearoma.com');

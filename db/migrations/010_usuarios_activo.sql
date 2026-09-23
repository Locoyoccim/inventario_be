-- Usuarios: activar/desactivar sin borrar (conserva el historial de movimientos).
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT true;

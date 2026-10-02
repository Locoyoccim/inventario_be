BEGIN;

-- La tabla roles existía pero no se usaba: el acceso real siempre fue binario (is_admin/
-- is_owner). Esta migración la convierte en un catálogo de permisos reales para usuarios
-- "Operativo", sin tocar is_admin/is_owner (dueño y admin siguen con acceso total).
ALTER TABLE public.roles
    ADD COLUMN IF NOT EXISTS clave varchar(30),
    ADD COLUMN IF NOT EXISTS permisos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- La tabla estaba vacía (roles nunca se usó): no hay filas legacy con clave NULL que proteger.
CREATE UNIQUE INDEX IF NOT EXISTS roles_clave_uidx ON public.roles (clave);

-- Catálogo fijo. "completo" conserva el comportamiento actual (un Operativo sin role_id
-- asignado se trata como "completo" en la app, ver activeUser.js) y queda disponible para
-- asignación explícita. "mesero" se deja sin permisos: hoy no opera nada en este panel;
-- es un lugar reservado para cuando exista un POS propio con operaciones de piso.
INSERT INTO public.roles (nombre, descripcion, clave, permisos) VALUES
    ('Operativo completo', 'Acceso a compras, conteos, producción, gastos e ingresos (todo lo no exclusivo de Admin).', 'completo',
        '["compras.crear","conteos.crear","produccion.crear","gastos.crear","ingresos.crear"]'::jsonb),
    ('Compras y almacén', 'Solo compras y conteos físicos.', 'compras',
        '["compras.crear","conteos.crear"]'::jsonb),
    ('Producción', 'Solo confirmar producción y conteos físicos.', 'produccion',
        '["produccion.crear","conteos.crear"]'::jsonb),
    ('Finanzas', 'Solo registrar gastos e ingresos.', 'finanzas',
        '["gastos.crear","ingresos.crear"]'::jsonb),
    ('Mesero (próximamente)', 'Reservado para operaciones de piso (mesas, órdenes) cuando exista un POS propio. Sin permisos en este panel.', 'mesero',
        '[]'::jsonb)
ON CONFLICT (clave) DO NOTHING;

COMMIT;

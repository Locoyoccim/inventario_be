BEGIN;

-- Bitácora manual de reservaciones (sin automatización: una persona de turno la carga y la
-- actualiza a mano, igual que antes se hacía en papel o WhatsApp). No modela mesas ni calcula
-- sobrecupo; es deliberadamente simple.
CREATE TABLE IF NOT EXISTS public.reservaciones (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    nombre_cliente varchar(120) NOT NULL,
    telefono_cliente varchar(30) NOT NULL,
    fecha date NOT NULL,
    hora time NOT NULL,
    personas integer NOT NULL,
    alergias text,
    comentarios text,
    estado varchar(20) NOT NULL DEFAULT 'pendiente',
    usuario_id integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reservaciones_estado_check CHECK (estado IN ('pendiente', 'confirmada', 'sentada', 'no_show', 'cancelada')),
    CONSTRAINT reservaciones_personas_check CHECK (personas > 0)
);

CREATE INDEX IF NOT EXISTS reservaciones_empresa_fecha_idx ON public.reservaciones (empresa_id, fecha);

-- Acceso al módulo: se agrega el permiso al catálogo existente (ver 027_roles_permisos.sql).
-- "mesero" ya estaba reservado para operaciones de piso y pasa de catálogo vacío a usarse.
UPDATE public.roles
SET permisos = permisos || '["reservaciones.gestionar"]'::jsonb
WHERE clave = 'mesero' AND NOT (permisos @> '["reservaciones.gestionar"]'::jsonb);

INSERT INTO public.roles (nombre, descripcion, clave, permisos) VALUES
    ('Hostess', 'Recibe y acomoda reservaciones de piso.', 'hostess',
        '["reservaciones.gestionar"]'::jsonb),
    ('Recepción', 'Punto de entrada de reservaciones y clientes.', 'recepcion',
        '["reservaciones.gestionar"]'::jsonb),
    ('Cajero', 'Cobra en caja y puede tomar reservaciones telefónicas.', 'cajero',
        '["reservaciones.gestionar","ingresos.crear"]'::jsonb),
    ('Supervisor', 'Respaldo operativo de turno: compras, conteos, producción, finanzas y reservaciones.', 'supervisor',
        '["compras.crear","conteos.crear","produccion.crear","gastos.crear","ingresos.crear","reservaciones.gestionar"]'::jsonb)
ON CONFLICT (clave) DO NOTHING;

COMMIT;

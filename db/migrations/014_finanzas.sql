BEGIN;

-- FINANZAS: ingresos y gastos (nada se borra físicamente; se anula).

-- 1) Categorías de gasto (por empresa, únicas sin distinguir mayúsculas)
CREATE TABLE IF NOT EXISTS public.categorias_gasto (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    nombre varchar(60) NOT NULL,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS categorias_gasto_empresa_nombre_uidx
    ON public.categorias_gasto (empresa_id, lower(nombre));

-- Sembrar las categorías base para cada empresa existente
INSERT INTO public.categorias_gasto (empresa_id, nombre)
SELECT e.id, c.nombre
FROM public.empresas e
CROSS JOIN (VALUES
    ('Renta'), ('Luz'), ('Agua'), ('Gas'), ('Sueldos'),
    ('Mantenimiento'), ('Publicidad'), ('Impuestos y comisiones'), ('Otros')
) AS c(nombre)
ON CONFLICT (empresa_id, lower(nombre)) DO NOTHING;

-- 2) Gastos
CREATE TABLE IF NOT EXISTS public.gastos (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    fecha date NOT NULL,
    categoria_id integer NOT NULL REFERENCES public.categorias_gasto(id) ON DELETE RESTRICT,
    concepto varchar(150) NOT NULL,
    monto numeric(12,2) NOT NULL CHECK (monto > 0),
    metodo_pago varchar(15) NOT NULL CHECK (metodo_pago IN ('EFECTIVO','TARJETA','TRANSFERENCIA','OTRO')),
    proveedor_id integer REFERENCES public.proveedores(id) ON DELETE RESTRICT,
    nota text,
    usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    anulado boolean NOT NULL DEFAULT false,
    anulado_at timestamptz,
    anulado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    motivo_anulacion text
);
CREATE INDEX IF NOT EXISTS gastos_empresa_fecha_idx ON public.gastos (empresa_id, fecha);

-- 3) Ingresos (varios por día: uno por método o varios conceptos)
CREATE TABLE IF NOT EXISTS public.ingresos (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    fecha date NOT NULL,
    metodo_pago varchar(15) NOT NULL CHECK (metodo_pago IN ('EFECTIVO','TARJETA','TRANSFERENCIA','OTRO')),
    monto numeric(12,2) NOT NULL CHECK (monto > 0),
    concepto varchar(150) NOT NULL DEFAULT 'Venta del día',
    nota text,
    usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    anulado boolean NOT NULL DEFAULT false,
    anulado_at timestamptz,
    anulado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    motivo_anulacion text
);
CREATE INDEX IF NOT EXISTS ingresos_empresa_fecha_idx ON public.ingresos (empresa_id, fecha);

-- 4) Detalle de la venta diaria (snapshot al importar; permite el ingreso esperado)
CREATE TABLE IF NOT EXISTS public.venta_diaria_detalle (
    id serial PRIMARY KEY,
    venta_diaria_id integer NOT NULL REFERENCES public.venta_diaria(id) ON DELETE CASCADE,
    nombre_pos text,
    cantidad numeric(12,3),
    tipo varchar(10) CHECK (tipo IN ('RECETA','INSUMO','IGNORAR','SIN_MAPEO')),
    receta_id integer REFERENCES public.recetas(id) ON DELETE SET NULL,
    producto_id integer REFERENCES public.productos(id) ON DELETE SET NULL,
    precio_unitario numeric(12,2)
);
CREATE INDEX IF NOT EXISTS venta_diaria_detalle_venta_idx ON public.venta_diaria_detalle (venta_diaria_id);

COMMIT;

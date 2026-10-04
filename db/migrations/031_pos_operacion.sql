BEGIN;

-- Turno de caja. Fase 2: solo apertura (fondo inicial); el corte con conteo llega después.
CREATE TABLE IF NOT EXISTS public.pos_turnos (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    usuario_id integer NOT NULL REFERENCES public.usuarios(id),
    fecha_negocio date NOT NULL,
    fondo_inicial numeric(12,2) NOT NULL DEFAULT 0,
    abierto_at timestamptz NOT NULL DEFAULT now(),
    cerrado_at timestamptz,
    efectivo_contado numeric(12,2),
    efectivo_esperado numeric(12,2),
    diferencia numeric(12,2),
    estado varchar(10) NOT NULL DEFAULT 'ABIERTO',
    CONSTRAINT pos_turnos_estado_check CHECK (estado IN ('ABIERTO', 'CERRADO')),
    CONSTRAINT pos_turnos_fondo_check CHECK (fondo_inicial >= 0)
);
-- Un cajero no puede tener dos turnos abiertos a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS pos_turnos_abierto_uidx ON public.pos_turnos (empresa_id, usuario_id) WHERE estado = 'ABIERTO';

-- Contador de folios por empresa (se incrementa bajo bloqueo de fila: sin huecos ni duplicados).
CREATE TABLE IF NOT EXISTS public.pos_folios (
    empresa_id integer PRIMARY KEY,
    ultimo integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.pos_cuentas (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    folio integer NOT NULL,
    tipo varchar(10) NOT NULL DEFAULT 'MESA',
    mesa_id integer REFERENCES public.mesas(id),
    reservacion_id integer REFERENCES public.reservaciones(id) ON DELETE SET NULL,
    nombre_cliente varchar(80),
    personas integer NOT NULL DEFAULT 1,
    mesero_id integer REFERENCES public.usuarios(id),
    turno_id integer REFERENCES public.pos_turnos(id),
    estado varchar(10) NOT NULL DEFAULT 'ABIERTA',
    unida_a integer REFERENCES public.pos_cuentas(id),
    dividida_de integer REFERENCES public.pos_cuentas(id),
    fecha_negocio date NOT NULL,
    abierta_at timestamptz NOT NULL DEFAULT now(),
    cerrada_at timestamptz,
    motivo_cancelacion text,
    next_comanda integer NOT NULL DEFAULT 1,
    CONSTRAINT pos_cuentas_folio_uk UNIQUE (empresa_id, folio),
    CONSTRAINT pos_cuentas_tipo_check CHECK (tipo IN ('MESA', 'LLEVAR')),
    CONSTRAINT pos_cuentas_estado_check CHECK (estado IN ('ABIERTA', 'PAGADA', 'CANCELADA', 'ANULADA', 'UNIDA')),
    CONSTRAINT pos_cuentas_mesa_check CHECK (tipo <> 'MESA' OR mesa_id IS NOT NULL),
    CONSTRAINT pos_cuentas_personas_check CHECK (personas > 0)
);
CREATE INDEX IF NOT EXISTS pos_cuentas_abiertas_idx ON public.pos_cuentas (empresa_id, estado);
CREATE INDEX IF NOT EXISTS pos_cuentas_mesa_idx ON public.pos_cuentas (mesa_id) WHERE estado = 'ABIERTA';

CREATE TABLE IF NOT EXISTS public.pos_comandas (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    cuenta_id integer NOT NULL REFERENCES public.pos_cuentas(id) ON DELETE CASCADE,
    area_id integer REFERENCES public.areas_preparacion(id) ON DELETE SET NULL,
    numero integer NOT NULL,
    creado_por integer REFERENCES public.usuarios(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Renglones: nombre, precio e IVA quedan congelados al agregarlos (un cambio de precio posterior
-- no altera cuentas abiertas). Exactamente uno de receta_id / producto_id.
CREATE TABLE IF NOT EXISTS public.pos_cuenta_items (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    cuenta_id integer NOT NULL REFERENCES public.pos_cuentas(id) ON DELETE CASCADE,
    receta_id integer REFERENCES public.recetas(id) ON DELETE SET NULL,
    producto_id integer REFERENCES public.productos(id) ON DELETE SET NULL,
    nombre varchar(150) NOT NULL,
    precio_unitario numeric(12,2) NOT NULL,
    iva_pct numeric(5,2) NOT NULL DEFAULT 0,
    precio_incluye_iva boolean NOT NULL DEFAULT true,
    cantidad integer NOT NULL,
    notas varchar(200),
    estado varchar(10) NOT NULL DEFAULT 'PENDIENTE',
    area_id integer REFERENCES public.areas_preparacion(id) ON DELETE SET NULL,
    comanda_id integer REFERENCES public.pos_comandas(id) ON DELETE SET NULL,
    descuento numeric(12,2) NOT NULL DEFAULT 0,
    cortesia boolean NOT NULL DEFAULT false,
    autorizado_por integer REFERENCES public.usuarios(id),
    motivo text,
    creado_por integer REFERENCES public.usuarios(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pos_items_origen_check CHECK ((receta_id IS NOT NULL) <> (producto_id IS NOT NULL)),
    CONSTRAINT pos_items_estado_check CHECK (estado IN ('PENDIENTE', 'ENVIADO', 'CANCELADO')),
    CONSTRAINT pos_items_cantidad_check CHECK (cantidad > 0),
    CONSTRAINT pos_items_precio_check CHECK (precio_unitario >= 0 AND descuento >= 0)
);
CREATE INDEX IF NOT EXISTS pos_items_cuenta_idx ON public.pos_cuenta_items (cuenta_id);

-- Impresoras del local. Cada una atiende comandas de un área o es la de tickets/cajón.
CREATE TABLE IF NOT EXISTS public.impresoras (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    nombre varchar(60) NOT NULL,
    conexion varchar(5) NOT NULL DEFAULT 'RED',
    ip varchar(45),
    puerto integer NOT NULL DEFAULT 9100,
    nombre_usb varchar(120),
    ancho integer NOT NULL DEFAULT 80,
    area_id integer REFERENCES public.areas_preparacion(id) ON DELETE SET NULL,
    es_ticket boolean NOT NULL DEFAULT false,
    activo boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT impresoras_empresa_nombre_uk UNIQUE (empresa_id, nombre),
    CONSTRAINT impresoras_conexion_check CHECK (conexion IN ('RED', 'USB')),
    CONSTRAINT impresoras_ancho_check CHECK (ancho IN (58, 80)),
    CONSTRAINT impresoras_destino_check CHECK ((conexion = 'RED' AND ip IS NOT NULL) OR (conexion = 'USB' AND nombre_usb IS NOT NULL)),
    CONSTRAINT impresoras_uso_check CHECK (area_id IS NOT NULL OR es_ticket)
);
CREATE INDEX IF NOT EXISTS impresoras_area_idx ON public.impresoras (empresa_id, area_id) WHERE activo;

-- Agente de impresión de la PC de caja: se autentica con su propio token (solo se guarda el hash).
CREATE TABLE IF NOT EXISTS public.agentes_impresion (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    nombre varchar(60) NOT NULL,
    token_hash char(64) NOT NULL UNIQUE,
    ultimo_contacto timestamptz,
    version varchar(20),
    activo boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Cola de impresión. payload es el contenido estructurado; el agente lo convierte a ESC/POS.
CREATE TABLE IF NOT EXISTS public.pos_impresiones (
    id serial PRIMARY KEY,
    empresa_id integer NOT NULL,
    tipo varchar(10) NOT NULL,
    referencia_id integer,
    impresora_id integer REFERENCES public.impresoras(id) ON DELETE SET NULL,
    estado varchar(12) NOT NULL DEFAULT 'PENDIENTE',
    intentos integer NOT NULL DEFAULT 0,
    error text,
    payload jsonb NOT NULL,
    bloqueado_hasta timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    impreso_at timestamptz,
    CONSTRAINT pos_impresiones_tipo_check CHECK (tipo IN ('COMANDA', 'PRECUENTA', 'TICKET', 'PRUEBA')),
    CONSTRAINT pos_impresiones_estado_check CHECK (estado IN ('PENDIENTE', 'IMPRIMIENDO', 'IMPRESO', 'ERROR'))
);
CREATE INDEX IF NOT EXISTS pos_impresiones_cola_idx ON public.pos_impresiones (empresa_id, estado, id);

COMMIT;

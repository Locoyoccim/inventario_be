--
-- PostgreSQL database dump
--


-- Dumped from database version 16.2
-- Dumped by pg_dump version 18.6 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: empresas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.empresas (
    id integer NOT NULL,
    nombre character varying(100) NOT NULL,
    titular character varying(100),
    telefono character varying(20),
    email character varying(100),
    domicilio text
);


--
-- Name: empresa_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.empresa_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: empresa_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.empresa_id_seq OWNED BY public.empresas.id;


--
-- Name: inventario; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventario (
    id integer NOT NULL,
    producto_id integer NOT NULL,
    stock_actual numeric(10,3) DEFAULT 0,
    stock_minimo numeric(10,3) DEFAULT 0,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    empresa_id integer
);


--
-- Name: productos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.productos (
    id integer NOT NULL,
    producto character varying(100) NOT NULL,
    unidad_medida character varying(50),
    proveedor_id integer,
    categoria character varying(50) DEFAULT 'sin categoria'::character varying,
    empresa_id integer,
    cantidad_presentacion numeric(10,3) NOT NULL,
    costo_presentacion numeric(10,2) NOT NULL,
    costo_unitario numeric(10,4) GENERATED ALWAYS AS ((costo_presentacion / cantidad_presentacion)) STORED
);


--
-- Name: inventario_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inventario_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inventario_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inventario_id_seq OWNED BY public.productos.id;


--
-- Name: inventario_id_seq1; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inventario_id_seq1
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inventario_id_seq1; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inventario_id_seq1 OWNED BY public.inventario.id;


--
-- Name: movimientosinventario; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.movimientosinventario (
    id integer NOT NULL,
    fecha timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    usuario_id integer,
    producto_id integer,
    tipo_movimiento character varying(20),
    cantidad numeric(10,3) NOT NULL,
    costo_unitario numeric(10,2),
    stock_anterior numeric(10,3),
    stock_nuevo numeric(10,3),
    motivo text,
    referencia_tipo character varying(50),
    referencia_id integer,
    CONSTRAINT movimientosinventario_tipo_movimiento_check CHECK (((tipo_movimiento)::text = ANY ((ARRAY['COMPRA'::character varying, 'VENTA'::character varying, 'MERMA'::character varying, 'AJUSTE'::character varying, 'DEVOLUCION'::character varying, 'PRODUCCION'::character varying])::text[])))
);


--
-- Name: movimientosinventario_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.movimientosinventario_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: movimientosinventario_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.movimientosinventario_id_seq OWNED BY public.movimientosinventario.id;


--
-- Name: pos_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_map (
    id integer NOT NULL,
    empresa_id integer NOT NULL,
    nombre_pos text NOT NULL,
    tipo text NOT NULL,
    receta_id integer,
    producto_id integer,
    factor numeric DEFAULT 1 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_map_ref_chk CHECK ((((tipo = 'RECETA'::text) AND (receta_id IS NOT NULL) AND (producto_id IS NULL)) OR ((tipo = 'INSUMO'::text) AND (producto_id IS NOT NULL) AND (receta_id IS NULL)) OR ((tipo = 'IGNORAR'::text) AND (receta_id IS NULL) AND (producto_id IS NULL)))),
    CONSTRAINT pos_map_tipo_check CHECK ((tipo = ANY (ARRAY['RECETA'::text, 'INSUMO'::text, 'IGNORAR'::text])))
);


--
-- Name: pos_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pos_map_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pos_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pos_map_id_seq OWNED BY public.pos_map.id;


--
-- Name: proveedores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proveedores (
    id integer NOT NULL,
    nombre character varying(100) NOT NULL,
    telefono character varying(20),
    email character varying(100),
    domicilio text,
    empresa_id integer
);


--
-- Name: proveedores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proveedores_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proveedores_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.proveedores_id_seq OWNED BY public.proveedores.id;


--
-- Name: receta_detalle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receta_detalle (
    id integer NOT NULL,
    receta_id integer NOT NULL,
    producto_id integer NOT NULL,
    cantidad numeric(10,3) NOT NULL,
    costo_unitario numeric(10,4) NOT NULL,
    costo_final numeric(10,2) GENERATED ALWAYS AS ((cantidad * costo_unitario)) STORED
);


--
-- Name: receta_detalle_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.receta_detalle_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receta_detalle_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.receta_detalle_id_seq OWNED BY public.receta_detalle.id;


--
-- Name: recetas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recetas (
    id integer NOT NULL,
    nombre character varying(100) NOT NULL,
    categoria character varying(50) NOT NULL,
    precio_venta numeric(10,2) DEFAULT 0 NOT NULL,
    costo_total numeric(10,2) DEFAULT 0,
    margen numeric(5,2) GENERATED ALWAYS AS (
CASE
    WHEN (precio_venta > (0)::numeric) THEN (((precio_venta - costo_total) / precio_venta) * (100)::numeric)
    ELSE (0)::numeric
END) STORED,
    activo boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    empresa_id integer,
    costo_produccion numeric DEFAULT 0 NOT NULL,
    proteccion_pct numeric DEFAULT 0 NOT NULL
);


--
-- Name: recetas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recetas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recetas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recetas_id_seq OWNED BY public.recetas.id;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id integer NOT NULL,
    nombre character varying(50) NOT NULL,
    descripcion text
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;




--
-- Name: usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios (
    id integer NOT NULL,
    nombre character varying(100) NOT NULL,
    codigo_ingreso character varying(50) NOT NULL,
    puesto character varying(100),
    is_admin boolean DEFAULT false,
    is_owner boolean DEFAULT false,
    role_id integer,
    empresa_id integer
);


--
-- Name: usuarios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.usuarios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: usuarios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.usuarios_id_seq OWNED BY public.usuarios.id;


--
-- Name: venta_diaria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venta_diaria (
    id integer NOT NULL,
    empresa_id integer NOT NULL,
    fecha date NOT NULL,
    total_lineas integer DEFAULT 0 NOT NULL,
    total_unidades numeric DEFAULT 0 NOT NULL,
    procesado_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: venta_diaria_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.venta_diaria_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: venta_diaria_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.venta_diaria_id_seq OWNED BY public.venta_diaria.id;


--
-- Name: empresas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresas ALTER COLUMN id SET DEFAULT nextval('public.empresa_id_seq'::regclass);


--
-- Name: inventario id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventario ALTER COLUMN id SET DEFAULT nextval('public.inventario_id_seq1'::regclass);


--
-- Name: movimientosinventario id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientosinventario ALTER COLUMN id SET DEFAULT nextval('public.movimientosinventario_id_seq'::regclass);


--
-- Name: pos_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_map ALTER COLUMN id SET DEFAULT nextval('public.pos_map_id_seq'::regclass);


--
-- Name: productos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.productos ALTER COLUMN id SET DEFAULT nextval('public.inventario_id_seq'::regclass);


--
-- Name: proveedores id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedores ALTER COLUMN id SET DEFAULT nextval('public.proveedores_id_seq'::regclass);


--
-- Name: receta_detalle id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_detalle ALTER COLUMN id SET DEFAULT nextval('public.receta_detalle_id_seq'::regclass);


--
-- Name: recetas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recetas ALTER COLUMN id SET DEFAULT nextval('public.recetas_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: usuarios id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios ALTER COLUMN id SET DEFAULT nextval('public.usuarios_id_seq'::regclass);


--
-- Name: venta_diaria id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_diaria ALTER COLUMN id SET DEFAULT nextval('public.venta_diaria_id_seq'::regclass);


--
-- Name: empresas empresa_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresas
    ADD CONSTRAINT empresa_pkey PRIMARY KEY (id);


--
-- Name: productos inventario_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.productos
    ADD CONSTRAINT inventario_pkey PRIMARY KEY (id);


--
-- Name: inventario inventario_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventario
    ADD CONSTRAINT inventario_pkey1 PRIMARY KEY (id);


--
-- Name: inventario inventario_producto_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventario
    ADD CONSTRAINT inventario_producto_id_key UNIQUE (producto_id);


--
-- Name: movimientosinventario movimientosinventario_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientosinventario
    ADD CONSTRAINT movimientosinventario_pkey PRIMARY KEY (id);


--
-- Name: pos_map pos_map_empresa_id_nombre_pos_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_map
    ADD CONSTRAINT pos_map_empresa_id_nombre_pos_key UNIQUE (empresa_id, nombre_pos);


--
-- Name: pos_map pos_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_map
    ADD CONSTRAINT pos_map_pkey PRIMARY KEY (id);


--
-- Name: proveedores proveedores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedores
    ADD CONSTRAINT proveedores_pkey PRIMARY KEY (id);


--
-- Name: receta_detalle receta_detalle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_detalle
    ADD CONSTRAINT receta_detalle_pkey PRIMARY KEY (id);


--
-- Name: recetas recetas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recetas
    ADD CONSTRAINT recetas_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: usuarios usuarios_codigo_ingreso_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_codigo_ingreso_key UNIQUE (codigo_ingreso);


--
-- Name: usuarios usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);


--
-- Name: venta_diaria venta_diaria_empresa_id_fecha_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_diaria
    ADD CONSTRAINT venta_diaria_empresa_id_fecha_key UNIQUE (empresa_id, fecha);


--
-- Name: venta_diaria venta_diaria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_diaria
    ADD CONSTRAINT venta_diaria_pkey PRIMARY KEY (id);


--
-- Name: idx_pos_map_empresa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_map_empresa ON public.pos_map USING btree (empresa_id);


--
-- Name: idx_venta_diaria_empresa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_venta_diaria_empresa ON public.venta_diaria USING btree (empresa_id);


--
-- Name: inventario fk_inventario_empresa; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventario
    ADD CONSTRAINT fk_inventario_empresa FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: productos fk_inventario_empresa; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.productos
    ADD CONSTRAINT fk_inventario_empresa FOREIGN KEY (empresa_id) REFERENCES public.empresas(id);


--
-- Name: inventario fk_inventario_producto; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventario
    ADD CONSTRAINT fk_inventario_producto FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: receta_detalle fk_producto; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_detalle
    ADD CONSTRAINT fk_producto FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: recetas fk_proveedores_empresa; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recetas
    ADD CONSTRAINT fk_proveedores_empresa FOREIGN KEY (empresa_id) REFERENCES public.empresas(id);


--
-- Name: receta_detalle fk_receta; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receta_detalle
    ADD CONSTRAINT fk_receta FOREIGN KEY (receta_id) REFERENCES public.recetas(id) ON DELETE CASCADE;


--
-- Name: productos inventario_proveedor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.productos
    ADD CONSTRAINT inventario_proveedor_id_fkey FOREIGN KEY (proveedor_id) REFERENCES public.proveedores(id) ON DELETE SET NULL;


--
-- Name: movimientosinventario movimientosinventario_producto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientosinventario
    ADD CONSTRAINT movimientosinventario_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES public.productos(id) ON DELETE CASCADE;


--
-- Name: movimientosinventario movimientosinventario_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.movimientosinventario
    ADD CONSTRAINT movimientosinventario_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id) ON DELETE SET NULL;


--
-- Name: pos_map pos_map_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_map
    ADD CONSTRAINT pos_map_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id);


--
-- Name: pos_map pos_map_producto_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_map
    ADD CONSTRAINT pos_map_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES public.productos(id);


--
-- Name: pos_map pos_map_receta_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_map
    ADD CONSTRAINT pos_map_receta_id_fkey FOREIGN KEY (receta_id) REFERENCES public.recetas(id);


--
-- Name: proveedores proveedores_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedores
    ADD CONSTRAINT proveedores_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;


--
-- Name: usuarios usuarios_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;


--
-- Name: usuarios usuarios_rol_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_rol_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE SET NULL;


--
-- Name: venta_diaria venta_diaria_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venta_diaria
    ADD CONSTRAINT venta_diaria_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id);


--
-- PostgreSQL database dump complete
--



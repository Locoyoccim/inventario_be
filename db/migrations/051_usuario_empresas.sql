BEGIN;

-- Acceso de un usuario a OTRAS empresas además de la suya (`usuarios.empresa_id`, su empresa «base», que no cambia).
-- Solo lo concede el usuario maestro de plataforma, y solo a Owner/Admin. Cada acceso lleva su propio rol: lo que la persona puede
-- hacer en esa empresa sale de AQUÍ, no de su fila base. La empresa activa de la sesión (claim `empresa_id` del JWT) debe ser la
-- base o un acceso vigente: así los datos siguen viajando por empresa y nunca mezclados.
--
-- «Retirar» no borra la fila: pone `activo = false`, para que los registros que esa persona dejó en la empresa (mesero_id,
-- usuario_id, anulado_por...) sigan teniendo un autor válido para `npm run audit:tenant`.
CREATE TABLE IF NOT EXISTS public.usuario_empresas (
    usuario_id integer NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    empresa_id integer NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
    is_admin boolean NOT NULL DEFAULT true,
    role_id integer REFERENCES public.roles(id) ON DELETE SET NULL,
    activo boolean NOT NULL DEFAULT true,
    otorgado_por integer REFERENCES public.usuarios(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (usuario_id, empresa_id)
);
CREATE INDEX IF NOT EXISTS usuario_empresas_empresa_idx ON public.usuario_empresas (empresa_id);

-- La empresa base no es un «acceso adicional»: sería una segunda fuente de verdad para lo mismo (y un rol distinto del de su fila).
CREATE OR REPLACE FUNCTION public.usuario_empresas_no_base() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.usuarios u WHERE u.id = NEW.usuario_id AND u.empresa_id = NEW.empresa_id) THEN
        RAISE EXCEPTION 'La empresa base del usuario no es un acceso adicional (usuario %, empresa %)', NEW.usuario_id, NEW.empresa_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS usuario_empresas_no_base ON public.usuario_empresas;
CREATE TRIGGER usuario_empresas_no_base
    BEFORE INSERT OR UPDATE OF usuario_id, empresa_id ON public.usuario_empresas
    FOR EACH ROW EXECUTE FUNCTION public.usuario_empresas_no_base();

COMMIT;

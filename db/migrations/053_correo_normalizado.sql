BEGIN;

-- AUD-003: el correo identifica a la persona en TODA la plataforma (el login lo busca sin empresa; ADR-010: una persona con varias
-- empresas es UN usuario). Hasta aquí `usuarios_email_unique` comparaba el texto tal cual, pero el login compara en minúsculas y sin
-- espacios: `Ana@x.com` en una empresa y `ana@x.com` en otra coexistían, y el login siempre devolvía la de menor id (la otra persona
-- no podía entrar, o entraba en la empresa equivocada).
--
-- Política: el correo se guarda SIEMPRE normalizado (minúsculas, sin espacios al borde) y es único global. La restricción CHECK lo
-- obliga en la base —ya no depende de que cada ruta recuerde normalizar— y con ella el índice único existente compara exactamente lo
-- que compara el login. Un correo vacío no es un correo: pasa a NULL.

-- 1) Auditoría previa: si dos filas chocarían al normalizar, NO se decide por nadie. La migración se detiene y dice cuáles
--    (solo ids; los correos no se imprimen en la salida de un despliegue). Resolverlo es una decisión de negocio: cuál de las
--    cuentas conserva el correo, o si son la misma persona y hay que darle acceso compartido (ADR-010) en vez de dos usuarios.
DO $$
DECLARE
    choques text;
BEGIN
    SELECT string_agg(grupo, E'\n')
      INTO choques
      FROM (
          SELECT format('  usuarios %s (empresas %s)', string_agg(id::text, ', ' ORDER BY id), string_agg(empresa_id::text, ', ' ORDER BY id)) AS grupo
            FROM public.usuarios
           WHERE nullif(btrim(email), '') IS NOT NULL
           GROUP BY lower(btrim(email))
          HAVING count(*) > 1
      ) g;
    IF choques IS NOT NULL THEN
        RAISE EXCEPTION E'Correos duplicados al normalizar (mayúsculas/espacios); resuélvelos a mano antes de migrar (npm run audit:correos):\n%', choques;
    END IF;
END
$$;

-- 2) Normaliza lo que ya existe (ya sin choques posibles).
UPDATE public.usuarios
   SET email = nullif(lower(btrim(email)), '')
 WHERE email IS NOT NULL
   AND email IS DISTINCT FROM nullif(lower(btrim(email)), '');

-- 3) La base lo exige desde ahora.
ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_email_normalizado_chk;
ALTER TABLE public.usuarios
    ADD CONSTRAINT usuarios_email_normalizado_chk
    CHECK (email IS NULL OR (email = lower(btrim(email)) AND email <> ''));

COMMIT;

// Comprueba al arrancar que la app se conecta a Postgres con un rol de PRIVILEGIOS MÍNIMOS (ADR-006 / VCA-015).
// Un superusuario puede ejecutar comandos en el servidor de la base (COPY ... PROGRAM), leer archivos, apagar triggers de integridad
// y se salta cualquier RLS futura; un dueño de las tablas puede además hacer DROP/TRUNCATE. La app no necesita nada de eso.

/** Consulta, con la conexión de la app, qué privilegios tiene el rol actual. */
export const SQL_ROL_ACTUAL = `
SELECT r.rolname AS usuario, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
       (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS tablas_propias
FROM pg_roles r WHERE r.rolname = current_user`;

/**
 * Función pura: decide qué hacer con el estado del rol.
 * @returns {{ nivel: "ok"|"aviso"|"error", motivos: string[] }}
 *  - ok: privilegios mínimos.
 *  - error: producción con privilegios de más y sin PERMITIR_DB_SUPERUSUARIO=1 → el servidor no debe arrancar.
 *  - aviso: privilegios de más pero tolerado (desarrollo, o producción con la bandera de escape).
 */
export function evaluarRolDeAplicacion(info, env) {
    const motivos = [];
    if (info.rolsuper) motivos.push("es SUPERUSUARIO");
    if (info.rolbypassrls) motivos.push("tiene BYPASSRLS (se saltaría la seguridad por fila)");
    if (info.rolcreaterole) motivos.push("puede crear roles (CREATEROLE)");
    if (info.rolcreatedb) motivos.push("puede crear bases (CREATEDB)");
    if (info.tablas_propias > 0) motivos.push(`es dueño de ${info.tablas_propias} tablas (podría hacer DROP/TRUNCATE/ALTER)`);
    if (motivos.length === 0) return { nivel: "ok", motivos };
    const productivo = env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
    if (productivo && env.PERMITIR_DB_SUPERUSUARIO !== "1") return { nivel: "error", motivos };
    return { nivel: "aviso", motivos };
}

/**
 * Verifica el rol de la app. Aborta el proceso SOLO si hay un hallazgo positivo en producción; si la base no responde no se
 * convierte una caída transitoria en un fallo de arranque (la app ya reporta su salud en /health/ready).
 * @param {{ query: Function }} db  pool o cliente de pg
 */
export async function verificarRolDeAplicacion(db, { env = process.env, log = console, salir = (c) => process.exit(c) } = {}) {
    let info;
    try {
        info = (await db.query(SQL_ROL_ACTUAL)).rows[0];
    } catch (e) {
        log.warn(`[db] No se pudo comprobar el rol de la base (${e.message}); se omite la verificación de privilegios.`);
        return { nivel: "desconocido", motivos: [] };
    }
    if (!info) return { nivel: "desconocido", motivos: [] };
    const r = evaluarRolDeAplicacion(info, env);
    const detalle = `El rol «${info.usuario}» ${r.motivos.join("; ")}.`;
    if (r.nivel === "error") {
        log.error(`Configuración insegura: ${detalle}`);
        log.error("La app debe conectarse con un rol de privilegios mínimos (gh_app). Ver docs/DB_ROLES.md (npm run db:roles).");
        log.error("Solo en una emergencia: PERMITIR_DB_SUPERUSUARIO=1 deja arrancar con este aviso.");
        salir(1);
    } else if (r.nivel === "aviso") {
        const tolerado = env.NODE_ENV === "development" || env.NODE_ENV === "test" ? "desarrollo" : "PERMITIR_DB_SUPERUSUARIO=1";
        log.warn(`[db] AVISO (${tolerado}): ${detalle} Usa el rol de privilegios mínimos (npm run db:roles).`);
    }
    return r;
}

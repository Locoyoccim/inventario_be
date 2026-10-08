/**
 * Conexión del rol MIGRADOR (dueño de las tablas) para los pocos fixtures de prueba que necesitan DDL: re-ejecutar una migración
 * o apagar un trigger un momento. El resto de la suite corre con el rol de la APP (TEST_DATABASE_URL), de privilegios mínimos.
 */
import pg from "pg";

export function crearPoolMigrador() {
    const url = process.env.TEST_MIGRATOR_URL;
    if (!url) throw new Error("Falta TEST_MIGRATOR_URL: URL del rol migrador (dueño de las tablas) de la base de pruebas. Ver README (npm run db:roles).");
    return new pg.Pool({ connectionString: url, max: 2 });
}

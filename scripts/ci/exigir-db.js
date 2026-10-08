/**
 * Primer paso de `npm run test:ci`. Con REQUIRE_DB=1 las pruebas de integración NO son opcionales: si falta TEST_DATABASE_URL
 * el proceso termina de inmediato con error, en vez de omitirlas y reportar «verde». Exige las DOS URLs: la de la app (rol de
 * privilegios mínimos, con la que corre la suite) y la del migrador (dueño de las tablas; solo para fixtures con DDL).
 */
if (process.env.REQUIRE_DB === "1") {
    const faltan = ["TEST_DATABASE_URL", "TEST_MIGRATOR_URL"].filter((v) => !process.env[v]);
    if (faltan.length) {
        console.error(`REQUIRE_DB=1 pero falta ${faltan.join(" y ")}: las pruebas de integración no pueden omitirse. TEST_DATABASE_URL = rol de la app (privilegios mínimos); TEST_MIGRATOR_URL = rol migrador (dueño de las tablas). Ver README (npm run db:roles).`);
        process.exit(1);
    }
}

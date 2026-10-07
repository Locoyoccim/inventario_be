/**
 * Primer paso de `npm run test:ci`. Con REQUIRE_DB=1 las pruebas de integración NO son opcionales: si falta TEST_DATABASE_URL
 * el proceso termina de inmediato con error, en vez de omitirlas y reportar «verde».
 */
if (process.env.REQUIRE_DB === "1" && !process.env.TEST_DATABASE_URL) {
    console.error("REQUIRE_DB=1 pero falta TEST_DATABASE_URL: las pruebas de integración no pueden omitirse. Define la URL de una base de pruebas.");
    process.exit(1);
}

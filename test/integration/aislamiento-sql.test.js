import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    compararConBaseline,
    extraerConsultas,
    leerEsquema,
    pendientesDeRevision,
} from "../helpers/escanerSql.js";

// Fase 5 · prueba C — regresión del SQL multiempresa. Falla si alguien agrega (o modifica) una consulta que toca una tabla con
// empresa_id sin filtrarla, o solo tablas hijas, y no está revisada en test/tenant-sql.baseline.json. Es una red contra omisiones
// (ver docs/TENANT_SQL_REVISION.md): la corrección de los filtros la demuestran las pruebas dinámicas A/B.
// Requiere TEST_DATABASE_URL: el esquema vivo dice qué tablas tienen empresa_id.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Aislamiento multiempresa — regresión del SQL (prueba C)", { skip: SKIP }, () => {
    let pool, esquema;

    before(async () => {
        ({ default: pool } = await import("../../src/config/db.js"));
        esquema = await leerEsquema(pool);
    });
    after(async () => {
        await pool.end();
    });

    it("todo SQL que toca una tabla con empresa_id sin filtrarla está revisado y documentado en el baseline", (t) => {
        const baseline = JSON.parse(readFileSync("test/tenant-sql.baseline.json", "utf8"));
        const consultas = extraerConsultas("src");
        const pendientes = pendientesDeRevision(consultas, esquema);
        t.diagnostic(
            `${consultas.length} literales SQL · ${pendientes.length} consultas a revisar (${pendientes.reduce((s, g) => s + g.ocurrencias, 0)} ocurrencias) · baseline: ${baseline.consultas.length}`,
        );
        assert.ok(
            esquema.conEmpresa.size >= 30,
            `el esquema debía tener ≥30 tablas con empresa_id y tiene ${esquema.conEmpresa.size}`,
        );
        assert.ok(
            consultas.length >= 400,
            "el escáner debía encontrar cientos de literales SQL: ¿cambió la estructura de src/?",
        );
        const problemas = compararConBaseline(pendientes, baseline);
        assert.deepEqual(problemas, [], `\n${problemas.join("\n")}`);
    });

    it("las consultas que SÍ filtran por empresa son la mayoría (el detector no está roto)", () => {
        const consultas = extraerConsultas("src");
        const tocanTenant = consultas.filter((c) => /empresa_id/i.test(c.sql));
        assert.ok(
            tocanTenant.length >= 250,
            `se esperaban ≥250 consultas que mencionan empresa_id y hay ${tocanTenant.length}`,
        );
    });
});

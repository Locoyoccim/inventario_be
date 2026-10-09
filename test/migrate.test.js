import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crearPoolMigrador } from "./helpers/migrador.js";
import { aplicarMigracion, normalizarSqlMigracion } from "../db/migrate.js";

test("normalizarSqlMigracion retira solo los delimitadores transaccionales heredados", () => {
    assert.equal(
        normalizarSqlMigracion("-- migración histórica\nBEGIN;\nCREATE TABLE ejemplo (id integer);\nCOMMIT;\n-- fin\n"),
        "-- migración histórica\nCREATE TABLE ejemplo (id integer);\n-- fin",
    );
    assert.equal(
        normalizarSqlMigracion("-- migración nueva\nALTER TABLE ejemplo ADD COLUMN activo boolean;\n"),
        "-- migración nueva\nALTER TABLE ejemplo ADD COLUMN activo boolean;",
    );
});

test("si falla el registro, revierte también el DDL de una migración con BEGIN/COMMIT heredados", async () => {
    const pool = crearPoolMigrador();
    const client = await pool.connect();
    const id = randomUUID().replaceAll("-", "");
    const filename = `__test_atomicidad_migracion_${id}.sql`;
    const table = `test_migracion_atomicidad_${id}`;
    let registroPreparado = false;

    try {
        // Provoca un fallo controlado al insertar el registro DESPUÉS del DDL.
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        registroPreparado = true;

        const sql = `BEGIN;\nCREATE TABLE public.${table} (id integer PRIMARY KEY);\nCOMMIT;\n`;
        await assert.rejects(
            aplicarMigracion(client, filename, sql),
            /duplicate key value violates unique constraint/,
        );

        const estado = await client.query("SELECT to_regclass($1) IS NOT NULL AS existe", [`public.${table}`]);
        assert.equal(estado.rows[0].existe, false, "el DDL debe revertirse si no puede registrarse la migración");
    } finally {
        await client.query(`DROP TABLE IF EXISTS public.${table}`);
        if (registroPreparado) {
            await client.query("DELETE FROM schema_migrations WHERE filename = $1", [filename]);
        }
        client.release();
        await pool.end();
    }
});

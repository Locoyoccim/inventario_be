import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { purgarIps, purgarPinFallos } from "../../scripts/purgar_ips.js";

// AUD-011: el aviso de privacidad promete conservar la IP de la bitácora 12 meses como máximo. La purga olvida SOLO la IP y deja la
// bitácora intacta; la app sigue sin poder modificar la bitácora por ningún otro camino.
// La bitácora es de solo inserción (la app no puede borrar sus filas): las de esta prueba se quedan en la base de pruebas, marcadas.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) process.env.DATABASE_URL = DB;

describe("Purga de IPs de la bitácora a los 12 meses (AUD-011)", { skip: SKIP }, () => {
    const EMPRESA = 9641;
    let pool;
    const marca = `purga-${Date.now().toString(36)}${process.pid}`;

    const alta = async (intervalo, ip) =>
        (
            await pool.query(
                `INSERT INTO admin_actividad (empresa_id, accion, objeto_tipo, objeto_id, detalle, ip, request_id, creado_at)
                 VALUES ($1, 'usuario.actualizar', 'usuario', 7, $2::jsonb, $3, $4, now() - $5::interval) RETURNING id`,
                [EMPRESA, JSON.stringify({ marca }), ip, marca, intervalo],
            )
        ).rows[0].id;
    const fila = async (id) =>
        (await pool.query("SELECT * FROM admin_actividad WHERE id = $1", [id])).rows[0];

    before(async () => {
        ({ default: pool } = await import("../../src/config/db.js"));
    });
    after(async () => {
        await pool.end();
    });

    it("olvida la IP de lo que pasó de 12 meses y conserva todo lo demás de la fila", async () => {
        const vieja = await alta("13 months", "203.0.113.7");
        const antes = await fila(vieja);
        const n = await purgarIps(pool);
        assert.ok(n >= 1);
        const despues = await fila(vieja);
        assert.equal(despues.ip, null);
        assert.deepEqual(
            { ...despues, ip: null },
            { ...antes, ip: null },
            "ningún otro campo cambia",
        );
        assert.equal(despues.accion, "usuario.actualizar");
        assert.equal(despues.request_id, marca);
    });

    it("no toca lo que aún no cumple 12 meses ni las filas que ya no tenían IP", async () => {
        const reciente = await alta("11 months 29 days", "203.0.113.8");
        const hoy = await alta("0 seconds", "203.0.113.9");
        const sinIp = await alta("14 months", null);
        await purgarIps(pool);
        assert.equal((await fila(reciente)).ip, "203.0.113.8");
        assert.equal((await fila(hoy)).ip, "203.0.113.9");
        assert.equal((await fila(sinIp)).ip, null);
    });

    it("es idempotente: la segunda vez no hay nada más que olvidar de lo ya purgado", async () => {
        const vieja = await alta("25 months", "203.0.113.10");
        await purgarIps(pool);
        assert.equal((await fila(vieja)).ip, null);
        const otra = await alta("12 months 1 day", "203.0.113.11");
        assert.ok((await purgarIps(pool)) >= 1);
        assert.equal((await fila(otra)).ip, null);
        assert.equal(await purgarIps(pool), 0, "sin filas nuevas que purgar, el conteo es 0");
    });

    it("la app sigue sin poder modificar la bitácora por su cuenta: la función es el único camino, y solo borra la IP", async () => {
        const id = await alta("0 seconds", "203.0.113.12");
        for (const sql of [
            "UPDATE admin_actividad SET ip = NULL WHERE id = $1",
            "UPDATE admin_actividad SET accion = 'usuario.crear' WHERE id = $1",
            "DELETE FROM admin_actividad WHERE id = $1",
        ])
            await assert.rejects(pool.query(sql, [id]), (e) => e.code === "42501", sql);
        assert.equal((await fila(id)).ip, "203.0.113.12");
    });

    it("borra los intentos fallidos de PIN de más de 1 día (con su IP) y deja los recientes", async () => {
        const E = 9642;
        const limpiar = async () => {
            await pool.query("DELETE FROM pin_fallos WHERE empresa_id = $1", [E]);
            await pool.query("DELETE FROM dispositivos WHERE empresa_id = $1", [E]);
            await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [E]);
            await pool.query("DELETE FROM empresas WHERE id = $1", [E]);
        };
        await limpiar();
        try {
            await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Purga PIN')", [E]);
            const u = (
                await pool.query(
                    "INSERT INTO usuarios (nombre,codigo_ingreso,empresa_id) VALUES ('P','PP-1',$1) RETURNING id",
                    [E],
                )
            ).rows[0].id;
            const d = (
                await pool.query(
                    "INSERT INTO dispositivos (empresa_id,nombre) VALUES ($1,'Caja') RETURNING id",
                    [E],
                )
            ).rows[0].id;
            for (const hace of ["2 days", "25 hours", "1 hour"])
                await pool.query(
                    "INSERT INTO pin_fallos (empresa_id,usuario_id,dispositivo_id,ip,created_at) VALUES ($1,$2,$3,'203.0.113.20', now() - $4::interval)",
                    [E, u, d, hace],
                );
            assert.ok((await purgarPinFallos(pool)) >= 2);
            const quedan = await pool.query(
                "SELECT count(*)::int n, count(ip)::int con_ip FROM pin_fallos WHERE empresa_id = $1",
                [E],
            );
            assert.deepEqual(quedan.rows[0], { n: 1, con_ip: 1 });
        } finally {
            await limpiar();
        }
    });
});

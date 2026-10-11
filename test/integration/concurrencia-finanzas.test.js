import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Auditoría · integridad de operaciones: finanzas. Totales exactos con altas simultáneas y anulación única de un gasto o un ingreso
// aunque lleguen varias peticiones a la vez. Se verifica el estado final de la base y el resumen que ve el negocio.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integridad — finanzas con concurrencia", { skip: SKIP }, () => {
    const A = 9981;
    const DIA = "2026-09-15";
    let server, base, pool, tok, adminId, categoriaId;

    const req = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                Authorization: `Bearer ${tok}`,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const texto = await res.text();
        let json = null;
        try {
            json = JSON.parse(texto);
        } catch {
            /* vacío */
        }
        return { status: res.status, json, texto };
    };
    const detalle = (rs) => rs.map((r) => `${r.status}: ${r.texto.slice(0, 140)}`).join("\n");
    const resumen = async () => {
        const r = await req("GET", `/api/finanzas/${A}/resumen?desde=${DIA}&hasta=${DIA}`);
        assert.equal(r.status, 200, r.texto);
        return r.json.data;
    };
    const cent = (n) => Math.round(Number(n) * 100);

    // Retiene una fila para que las peticiones lleguen JUNTAS a su escritura: todas leen «no anulado» (la lectura no se bloquea) y se
    // acumulan en el UPDATE; al soltar la fila se ejecutan una tras otra. Sin esto, la carrera «pasa» o no según los tiempos.
    const reteniendo = async (tabla, id, lanzar) => {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            await c.query(`SELECT 1 FROM ${tabla} WHERE id = $1 FOR UPDATE`, [id]);
            const pendientes = lanzar();
            await new Promise((r) => setTimeout(r, 500));
            await c.query("COMMIT");
            return await Promise.all(pendientes);
        } finally {
            c.release();
        }
    };

    const mkGasto = async (monto, concepto = "Gasto") => {
        const r = await req("POST", `/api/finanzas/${A}/gastos`, {
            fecha: DIA,
            categoria_id: categoriaId,
            concepto,
            monto,
            metodo_pago: "EFECTIVO",
        });
        assert.equal(r.status, 201, r.texto);
        return r.json.data.id;
    };
    const mkIngreso = async (monto) => {
        const r = await req("POST", `/api/finanzas/${A}/ingresos`, {
            fecha: DIA,
            metodo_pago: "EFECTIVO",
            monto,
            concepto: "Ingreso",
        });
        assert.equal(r.status, 201, r.texto);
        return r.json.data.id;
    };

    const limpiar = async () => {
        await pool.query("DELETE FROM gastos WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM ingresos WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM categorias_gasto WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [A]);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Finanzas concurrencia')", [
            A,
        ]);
        adminId = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm','FC-adm',true,true,$1) RETURNING id",
                [A],
            )
        ).rows[0].id;
        tok = signToken({ id: adminId, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        const c = await req("POST", `/api/finanzas/${A}/categorias-gasto`, { nombre: "Servicios" });
        assert.equal(c.status, 201, c.texto);
        categoriaId = c.json.data.id;
    });

    after(async () => {
        try {
            await limpiar();
        } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("20 gastos y 20 ingresos con centavos creados a la vez: ninguno se pierde ni se duplica y el resumen es la suma exacta", async () => {
        const rs = await Promise.all([
            ...Array.from({ length: 20 }, (_, i) =>
                req("POST", `/api/finanzas/${A}/gastos`, {
                    fecha: DIA,
                    categoria_id: categoriaId,
                    concepto: `Lote ${i}`,
                    monto: 12.34,
                    metodo_pago: "EFECTIVO",
                }),
            ),
            ...Array.from({ length: 20 }, () =>
                req("POST", `/api/finanzas/${A}/ingresos`, {
                    fecha: DIA,
                    metodo_pago: "TARJETA",
                    monto: 7.77,
                    concepto: "Lote",
                }),
            ),
        ]);
        assert.ok(
            rs.every((r) => r.status === 201),
            detalle(rs),
        );
        const db = await pool.query(
            `SELECT (SELECT count(*)::int FROM gastos WHERE empresa_id = $1) g, (SELECT count(*)::int FROM ingresos WHERE empresa_id = $1) i`,
            [A],
        );
        assert.deepEqual(db.rows[0], { g: 20, i: 20 });
        const r = await resumen();
        assert.equal(cent(r.gastos.total), 20 * 1234, "total de gastos del resumen");
        assert.equal(cent(r.ingresos.total), 20 * 777, "total de ingresos del resumen");
        assert.equal(
            cent(r.flujo),
            20 * 777 - 20 * 1234,
            "el flujo es ingresos − gastos, sin redondeos acumulados",
        );
    });

    it("anular 5 de 10 gastos a la vez: el resumen descuenta exactamente los anulados", async () => {
        await limpiarGastosEIngresos();
        const ids = [];
        for (let i = 0; i < 10; i++) ids.push(await mkGasto(10.1, `Anulable ${i}`));
        const rs = await Promise.all(
            ids
                .slice(0, 5)
                .map((id) =>
                    req("POST", `/api/finanzas/${A}/gastos/${id}/anular`, { motivo: "prueba" }),
                ),
        );
        assert.ok(
            rs.every((r) => r.status === 200),
            detalle(rs),
        );
        const db = await pool.query(
            "SELECT count(*) FILTER (WHERE anulado)::int a, count(*)::int n FROM gastos WHERE empresa_id = $1",
            [A],
        );
        assert.deepEqual(db.rows[0], { a: 5, n: 10 });
        assert.equal(cent((await resumen()).gastos.total), 5 * 1010);
    });

    async function limpiarGastosEIngresos() {
        await pool.query("DELETE FROM gastos WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM ingresos WHERE empresa_id = $1", [A]);
    }

    it("anular el mismo gasto 6 veces a la vez: una sola anulación se confirma, el resto es 409, y queda el motivo de la ganadora", async () => {
        await limpiarGastosEIngresos();
        const id = await mkGasto(50, "Doble anulación");
        const rs = await reteniendo("gastos", id, () =>
            Array.from({ length: 6 }, (_, i) =>
                req("POST", `/api/finanzas/${A}/gastos/${id}/anular`, { motivo: `motivo-${i}` }),
            ),
        );
        const buenas = rs.filter((r) => r.status === 200);
        assert.equal(
            buenas.length,
            1,
            `se confirmaron ${buenas.length} anulaciones del mismo gasto:\n${detalle(rs)}`,
        );
        assert.equal(rs.filter((r) => r.status === 409).length, 5, detalle(rs));
        const fila = (
            await pool.query("SELECT anulado, motivo_anulacion FROM gastos WHERE id = $1", [id])
        ).rows[0];
        assert.equal(fila.anulado, true);
        assert.equal(
            fila.motivo_anulacion,
            buenas[0].json.data.motivo_anulacion,
            "el motivo guardado es el de la anulación confirmada",
        );
    });

    it("anular el mismo ingreso 6 veces a la vez: una sola anulación se confirma, el resto es 409", async () => {
        await limpiarGastosEIngresos();
        const id = await mkIngreso(80);
        const rs = await reteniendo("ingresos", id, () =>
            Array.from({ length: 6 }, (_, i) =>
                req("POST", `/api/finanzas/${A}/ingresos/${id}/anular`, { motivo: `motivo-${i}` }),
            ),
        );
        const buenas = rs.filter((r) => r.status === 200);
        assert.equal(
            buenas.length,
            1,
            `se confirmaron ${buenas.length} anulaciones del mismo ingreso:\n${detalle(rs)}`,
        );
        assert.equal(rs.filter((r) => r.status === 409).length, 5, detalle(rs));
        const fila = (
            await pool.query("SELECT anulado, motivo_anulacion FROM ingresos WHERE id = $1", [id])
        ).rows[0];
        assert.equal(fila.motivo_anulacion, buenas[0].json.data.motivo_anulacion);
    });
});

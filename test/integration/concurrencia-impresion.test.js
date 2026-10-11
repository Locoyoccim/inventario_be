import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";

// Auditoría · integridad de operaciones: cola de impresión. Varios agentes que reclaman a la vez, el resultado de un trabajo que llega
// repetido o contradictorio, y descartar contra reclamar. Se verifica el estado final de pos_impresiones, no solo la respuesta.

const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Integridad — cola de impresión con concurrencia", { skip: SKIP }, () => {
    const A = 9991;
    let server, base, pool, tok, repo, impresora, agentes;

    const mkAgente = async (nombre) =>
        (
            await pool.query(
                "INSERT INTO agentes_impresion (empresa_id, nombre, token_hash) VALUES ($1,$2,$3) RETURNING id",
                [A, nombre, `${nombre}-${A}`.padEnd(64, "0")],
            )
        ).rows[0].id;
    const mkTrabajo = async (estado = "PENDIENTE") =>
        (
            await pool.query(
                `INSERT INTO pos_impresiones (empresa_id, tipo, referencia_id, impresora_id, estado, payload, bloqueado_hasta, intentos)
                 VALUES ($1,'PRUEBA',$2,$2,$3::varchar,'{}', CASE WHEN $3::varchar = 'IMPRIMIENDO' THEN now() + interval '30 seconds' END, 0) RETURNING id`,
                [A, impresora, estado],
            )
        ).rows[0].id;
    const estadoDe = async (id) =>
        (await pool.query("SELECT estado, intentos FROM pos_impresiones WHERE id = $1", [id]))
            .rows[0];
    const reteniendo = async (id, lanzar) => {
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            await c.query("SELECT 1 FROM pos_impresiones WHERE id = $1 FOR UPDATE", [id]);
            const pendientes = lanzar();
            await new Promise((r) => setTimeout(r, 400));
            await c.query("COMMIT");
            return await Promise.all(pendientes);
        } finally {
            c.release();
        }
    };

    const limpiar = async () => {
        await pool.query("DELETE FROM pos_impresiones WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM impresoras WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM agentes_impresion WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [A]);
        await pool.query("DELETE FROM empresas WHERE id = $1", [A]);
    };

    before(async () => {
        const appMod = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        const { default: Repo } = await import("../../src/modules/pos/pos.impresion.repository.js");
        repo = new Repo();
        ({ server, base } = await iniciarServidor(appMod.default));
        await limpiar();
        await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Impresión concurrencia')", [
            A,
        ]);
        const uid = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,is_admin,is_owner,empresa_id) VALUES ('Adm','CP-adm',true,true,$1) RETURNING id",
                [A],
            )
        ).rows[0].id;
        tok = signToken({ id: uid, empresa_id: A, is_admin: true, is_owner: true, tv: 0 });
        agentes = [await mkAgente("Caja"), await mkAgente("Barra"), await mkAgente("Cocina")];
        // Impresora sin agente asignado: cualquiera de los tres agentes de la empresa puede reclamar sus trabajos.
        impresora = (
            await pool.query(
                "INSERT INTO impresoras (empresa_id,nombre,conexion,ip,es_ticket) VALUES ($1,'Tickets','RED','10.0.0.9',true) RETURNING id",
                [A],
            )
        ).rows[0].id;
    });

    after(async () => {
        try {
            await limpiar();
        } finally {
            await new Promise((r) => server.close(r));
            await pool.end();
        }
    });

    it("3 agentes reclamando a la vez 40 trabajos: cada trabajo se entrega a un solo agente, ninguno se pierde ni se repite", async () => {
        const ids = [];
        for (let i = 0; i < 40; i++) ids.push(await mkTrabajo());
        const recibido = [];
        // Varias rondas de reclamos simultáneos hasta vaciar la cola: 3 agentes × 6 llamadas por ronda.
        for (let ronda = 0; ronda < 4; ronda++) {
            const lotes = await Promise.all(
                agentes.flatMap((a) =>
                    Array.from({ length: 6 }, () => repo.reclamarPendientes(A, a, 5)),
                ),
            );
            for (const lote of lotes) recibido.push(...lote.map((j) => j.id));
        }
        assert.equal(
            recibido.length,
            new Set(recibido).size,
            `trabajos entregados más de una vez: ${recibido.filter((x, i) => recibido.indexOf(x) !== i)}`,
        );
        assert.deepEqual(
            [...recibido].sort((a, b) => a - b),
            ids,
            "todos los trabajos se entregaron, exactamente una vez",
        );
        const { rows } = await pool.query(
            "SELECT estado, intentos FROM pos_impresiones WHERE id = ANY($1)",
            [ids],
        );
        assert.ok(
            rows.every((r) => r.estado === "IMPRIMIENDO" && r.intentos === 0),
            "todos quedan en impresión, sin reintentos fantasma",
        );
    });

    it("descartar contra reclamar el mismo trabajo (30 veces): o lo descarta quien gana o lo imprime el agente, nunca los dos", async () => {
        for (let i = 0; i < 30; i++) {
            const id = await mkTrabajo();
            const [descarte, reclamo] = await Promise.all([
                fetch(`${base}/api/pos/${A}/impresiones/${id}/descartar`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
                    body: "{}",
                }),
                repo.reclamarPendientes(A, agentes[0], 50),
            ]);
            const entregado = reclamo.some((j) => j.id === id);
            const { estado } = await estadoDe(id);
            if (descarte.status === 200) {
                assert.equal(estado, "DESCARTADA", "descartado: no puede seguir en impresión");
                assert.equal(entregado, false, "se descartó Y se entregó al agente");
            } else {
                assert.equal(descarte.status, 409, `descartar respondió ${descarte.status}`);
                assert.equal(
                    entregado,
                    true,
                    "el descarte falló pero el agente tampoco lo recibió",
                );
                assert.equal(estado, "IMPRIMIENDO");
            }
        }
    });

    it("el resultado de un trabajo llega contradictorio y repetido a la vez (ok, fallo, ok): se resuelve una sola vez y lo impreso no vuelve a la cola", async () => {
        const id = await mkTrabajo("IMPRIMIENDO");
        const rs = await reteniendo(id, () =>
            [
                repo.resultado(A, id, { ok: true }),
                repo.resultado(A, id, { ok: false, error: "papel atascado" }),
                repo.resultado(A, id, { ok: true }),
            ].map((p) =>
                p.then(
                    (v) => ({ ok: true, v }),
                    (e) => ({ ok: false, e }),
                ),
            ),
        );
        const resueltos = rs.filter((r) => r.ok);
        assert.equal(
            resueltos.length,
            1,
            `se resolvió ${resueltos.length} veces el mismo trabajo: ${JSON.stringify(rs.map((r) => r.v?.estado ?? r.e?.message))}`,
        );
        const { estado } = await estadoDe(id);
        assert.equal(
            estado,
            resueltos[0].v.estado,
            "el estado final es el de la única respuesta confirmada",
        );
    });
});

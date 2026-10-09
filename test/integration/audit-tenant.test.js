import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { iniciarServidor } from "../helpers/servidor.js";
import { descubrirAlcance, limpiarEmpresas } from "../helpers/alcance.js";
import { tomarCompartido } from "../helpers/exclusion.js";
import { EmpresaPrueba } from "../helpers/empresaCompleta.js";
import { auditarSoloLectura, POLIMORFICAS, SIN_FK } from "../../scripts/audit_tenant.js";

// Fase 5 · npm run audit:tenant — auditoría de datos de solo lectura. Se prueba que (1) una base sana sale limpia, (2) cada tipo de
// contaminación entre empresas se detecta (inyectándola de verdad y revirtiéndola), (3) solo emite SELECT y (4) no hay columnas
// *_id sin FK que se le escapen. Requiere TEST_DATABASE_URL.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("audit:tenant — contaminación entre empresas (solo lectura)", { skip: SKIP }, () => {
    const IDS = [9881, 9882];
    let server, pool, alcance, A, B;
    const auditoria = (opciones = { empresas: IDS }) => auditarSoloLectura(pool, opciones);
    const relaciones = (r) => r.hallazgos.map((h) => h.relacion);

    let candado;
    before(async () => {
        // Antes de leer el esquema: otro archivo puede estar ejecutando algo global (ver test/helpers/exclusion.js).
        candado = await tomarCompartido();
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        let base;
        ({ server, base } = await iniciarServidor(app));
        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, IDS, alcance);
        A = await new EmpresaPrueba({ id: IDS[0], etiqueta: "A", base, pool, signToken }).iniciar();
        B = await new EmpresaPrueba({ id: IDS[1], etiqueta: "B", base, pool, signToken }).iniciar();
    });

    after(async () => {
        await limpiarEmpresas(pool, IDS, alcance);
        await pool.end();
        await new Promise((r) => server.close(r));
        await candado?.liberar();
    });

    it("dos empresas completas y sanas no tienen contaminación, y se revisaron más de cien relaciones", async () => {
        await A.nuevo("cuentaPagada");
        await B.nuevo("cuentaPagada");
        await A.nuevo("compra");
        await A.nuevo("produccion");
        const r = await auditoria();
        assert.deepEqual(r.hallazgos, []);
        assert.ok(r.revisadas >= 100, `se esperaban ≥100 relaciones y se revisaron ${r.revisadas}`);
        assert.ok(
            r.omitidas.length <= 4, // roles (usuarios y usuario_empresas) + las dos claves del acceso compartido (cruzan empresas por diseño)
            `demasiadas relaciones omitidas: ${r.omitidas.join(", ")}`,
        );
    });

    // Cada escenario deja un dato de A apuntando a un dato de B, comprueba que se detecta y lo revierte.
    const ESCENARIOS = [
        {
            nombre: "renglón de una empresa dentro de una cuenta de otra",
            esperada: /pos_cuenta_items\.cuenta_id → pos_cuentas\.id/,
            inyectar: async () => {
                const a = await A.nuevo("cuentaConItems");
                const b = await B.nuevo("cuenta");
                await pool.query("UPDATE pos_cuenta_items SET cuenta_id = $1 WHERE id = $2", [
                    b.id,
                    a.item_id,
                ]);
                return () =>
                    pool.query("UPDATE pos_cuenta_items SET cuenta_id = $1 WHERE id = $2", [
                        a.id,
                        a.item_id,
                    ]);
            },
        },
        {
            nombre: "producto con el proveedor de otra empresa",
            esperada: /productos\.proveedor_id → proveedores\.id/,
            inyectar: async () => {
                const p = await A.nuevo("producto");
                await pool.query("UPDATE productos SET proveedor_id = $1 WHERE id = $2", [
                    B.proveedorBase.id,
                    p.id,
                ]);
                return () =>
                    pool.query("UPDATE productos SET proveedor_id = $1 WHERE id = $2", [
                        A.proveedorBase.id,
                        p.id,
                    ]);
            },
        },
        {
            nombre: "ingrediente de receta que es un producto de otra empresa",
            esperada: /receta_detalle\./,
            inyectar: async () => {
                const r = await A.nuevo("receta");
                const det = (
                    await pool.query(
                        "SELECT id, producto_id FROM receta_detalle WHERE receta_id = $1 LIMIT 1",
                        [r.id],
                    )
                ).rows[0];
                await pool.query("UPDATE receta_detalle SET producto_id = $1 WHERE id = $2", [
                    B.productoBase.id,
                    det.id,
                ]);
                return () =>
                    pool.query("UPDATE receta_detalle SET producto_id = $1 WHERE id = $2", [
                        det.producto_id,
                        det.id,
                    ]);
            },
        },
        {
            nombre: "movimiento de kardex de un producto de A atribuido a un usuario de B",
            esperada: /movimientosinventario\.usuario_id → usuarios\.id/,
            inyectar: async () => {
                const p = await A.nuevo("producto");
                await A.crear("POST", `/api/productos/${A.id}/${p.id}/movimientos`, {
                    tipo_movimiento: "MERMA",
                    cantidad: 1,
                    motivo: "kardex",
                });
                const m = (
                    await pool.query(
                        "SELECT id, usuario_id FROM movimientosinventario WHERE producto_id = $1 ORDER BY id DESC LIMIT 1",
                        [p.id],
                    )
                ).rows[0];
                await pool.query("UPDATE movimientosinventario SET usuario_id = $1 WHERE id = $2", [
                    B.adminId,
                    m.id,
                ]);
                return () =>
                    pool.query("UPDATE movimientosinventario SET usuario_id = $1 WHERE id = $2", [
                        m.usuario_id,
                        m.id,
                    ]);
            },
        },
        {
            nombre: "kardex de A cuya referencia (compra) es de B (referencia polimórfica sin FK)",
            esperada: /movimientosinventario\.referencia_id → compra\.id/,
            inyectar: async () => {
                const ca = await A.nuevo("compra");
                const cb = await B.nuevo("compra");
                const m = (
                    await pool.query(
                        "SELECT id FROM movimientosinventario WHERE referencia_tipo = 'COMPRA' AND referencia_id = $1 LIMIT 1",
                        [ca.id],
                    )
                ).rows[0];
                await pool.query(
                    "UPDATE movimientosinventario SET referencia_id = $1 WHERE id = $2",
                    [cb.id, m.id],
                );
                return () =>
                    pool.query(
                        "UPDATE movimientosinventario SET referencia_id = $1 WHERE id = $2",
                        [ca.id, m.id],
                    );
            },
        },
        {
            nombre: "impresión de A que apunta a una comanda de B (polimórfica)",
            esperada: /pos_impresiones\.referencia_id → pos_comandas\.id/,
            inyectar: async () => {
                const a = await A.nuevo("cuentaEnviada");
                const b = await B.nuevo("cuentaEnviada");
                await pool.query("UPDATE pos_impresiones SET referencia_id = $1 WHERE id = $2", [
                    b.comanda_id,
                    a.impresion_id,
                ]);
                return () =>
                    pool.query("UPDATE pos_impresiones SET referencia_id = $1 WHERE id = $2", [
                        a.comanda_id,
                        a.impresion_id,
                    ]);
            },
        },
        {
            nombre: "autorización de A sobre un renglón de B (columna sin FK)",
            esperada: /pos_autorizaciones\.item_id → pos_cuenta_items\.id/,
            inyectar: async () => {
                const a = await A.nuevo("cuentaEnviada");
                const b = await B.nuevo("cuentaEnviada");
                await A.crear(
                    "POST",
                    `/api/pos/${A.id}/cuentas/${a.id}/items/${a.item_id}/cancelar`,
                    { motivo: "auditoría" },
                );
                await pool.query(
                    "UPDATE pos_autorizaciones SET item_id = $1 WHERE cuenta_id = $2 AND item_id = $3",
                    [b.item_id, a.id, a.item_id],
                );
                return () =>
                    pool.query(
                        "UPDATE pos_autorizaciones SET item_id = $1 WHERE cuenta_id = $2 AND item_id = $3",
                        [a.item_id, a.id, b.item_id],
                    );
            },
        },
        {
            nombre: "cuenta de A atendida por un mesero de B",
            esperada: /pos_cuentas\.mesero_id → usuarios\.id/,
            inyectar: async () => {
                const a = await A.nuevo("cuenta");
                await pool.query("UPDATE pos_cuentas SET mesero_id = $1 WHERE id = $2", [
                    B.adminId,
                    a.id,
                ]);
                return () =>
                    pool.query("UPDATE pos_cuentas SET mesero_id = $1 WHERE id = $2", [
                        A.adminId,
                        a.id,
                    ]);
            },
        },
        {
            nombre: "llave de idempotencia de A atribuida a un usuario de B (columna sin FK)",
            esperada: /pos_idempotencia\.usuario_id → usuarios\.id/,
            inyectar: async () => {
                const llave = `auditoria-${Date.now()}-llave`;
                await pool.query(
                    "INSERT INTO pos_idempotencia (empresa_id, usuario_id, clave, endpoint, req_hash) VALUES ($1,$2,$3,'POST /x','h')",
                    [A.id, B.adminId, llave],
                );
                return () => pool.query("DELETE FROM pos_idempotencia WHERE clave = $1", [llave]);
            },
        },
    ];

    // Acceso compartido (usuario_empresas): quien tiene —o tuvo— acceso a una empresa es un autor válido de sus filas.
    it("un autor con acceso compartido a la empresa NO es contaminación (vigente ni retirado); sin acceso, sí", async () => {
        const p = await A.nuevo("producto");
        await A.crear("POST", `/api/productos/${A.id}/${p.id}/movimientos`, {
            tipo_movimiento: "MERMA",
            cantidad: 1,
            motivo: "autor compartido",
        });
        const m = (
            await pool.query(
                "SELECT id, usuario_id FROM movimientosinventario WHERE producto_id = $1 ORDER BY id DESC LIMIT 1",
                [p.id],
            )
        ).rows[0];
        const usuarioDeMov = /movimientosinventario\.usuario_id → usuarios\.id/;
        await pool.query("UPDATE movimientosinventario SET usuario_id = $1 WHERE id = $2", [
            B.adminId,
            m.id,
        ]);
        try {
            assert.ok(
                relaciones(await auditoria()).some((x) => usuarioDeMov.test(x)),
                "sin acceso: contaminación",
            );
            await pool.query(
                "INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES ($1, $2)",
                [B.adminId, A.id],
            );
            assert.ok(
                !relaciones(await auditoria()).some((x) => usuarioDeMov.test(x)),
                "con acceso vigente: autor válido",
            );
            await pool.query(
                "UPDATE usuario_empresas SET activo = false WHERE usuario_id = $1 AND empresa_id = $2",
                [B.adminId, A.id],
            );
            assert.ok(
                !relaciones(await auditoria()).some((x) => usuarioDeMov.test(x)),
                "con acceso retirado: lo que hizo sigue teniendo autor válido",
            );
        } finally {
            await pool.query(
                "DELETE FROM usuario_empresas WHERE usuario_id = $1 AND empresa_id = $2",
                [B.adminId, A.id],
            );
            await pool.query("UPDATE movimientosinventario SET usuario_id = $1 WHERE id = $2", [
                m.usuario_id,
                m.id,
            ]);
        }
        assert.deepEqual((await auditoria()).hallazgos, []);
    });

    it("las claves del acceso compartido (persona y quien lo otorgó) no cuentan como cruce de empresas, y un acceso a la empresa base sí se detecta", async () => {
        await pool.query(
            "INSERT INTO usuario_empresas (usuario_id, empresa_id, otorgado_por) VALUES ($1, $2, $3)",
            [B.adminId, A.id, A.adminId],
        );
        try {
            const r = await auditoria();
            assert.deepEqual(r.hallazgos, [], "un acceso legítimo no es hallazgo");
            assert.ok(r.omitidas.some((x) => /usuario_empresas\.usuario_id/.test(x)));
            // La persona se muda a la empresa del acceso (su base pasa a ser A): ese acceso ya no es «adicional».
            await pool.query("UPDATE usuarios SET empresa_id = $1 WHERE id = $2", [
                A.id,
                B.adminId,
            ]);
            assert.ok(
                relaciones(await auditoria()).some((x) =>
                    /usuario_empresas .*base de la persona/.test(x),
                ),
                "no se detectó el acceso a la empresa base",
            );
        } finally {
            await pool.query("UPDATE usuarios SET empresa_id = $1 WHERE id = $2", [
                B.id,
                B.adminId,
            ]);
            await pool.query("DELETE FROM usuario_empresas WHERE usuario_id = $1", [B.adminId]);
        }
        assert.deepEqual((await auditoria()).hallazgos, []);
    });

    for (const esc of ESCENARIOS) {
        it(`detecta: ${esc.nombre}`, async () => {
            const revertir = await esc.inyectar();
            try {
                const r = await auditoria();
                assert.ok(
                    relaciones(r).some((x) => esc.esperada.test(x)),
                    `no se detectó ${esc.esperada}. Hallazgos: ${JSON.stringify(relaciones(r))}`,
                );
                const h = r.hallazgos.find((x) => esc.esperada.test(x.relacion));
                assert.ok(
                    h.filas >= 1 && h.ejemplos.length >= 1,
                    "el hallazgo debe traer el número de filas y ids de ejemplo",
                );
            } finally {
                await revertir();
            }
            assert.deepEqual(
                (await auditoria()).hallazgos,
                [],
                "tras revertir, la auditoría debe volver a salir limpia",
            );
        });
    }

    it("una categoría por nombre que solo existe en otra empresa se detecta (o la base ya lo impide con un trigger)", async () => {
        const p = await A.nuevo("producto");
        const otra = await B.nuevo("categoria");
        let inyectado = false;
        try {
            await pool.query("UPDATE productos SET categoria = $1 WHERE id = $2", [
                otra.nombre,
                p.id,
            ]);
            inyectado = true;
        } catch (e) {
            assert.match(
                e.message,
                /categor/i,
                "si la base lo impide, debe ser por la validación de categoría",
            );
        }
        if (inyectado) {
            try {
                assert.ok(
                    relaciones(await auditoria()).some((x) => /productos\.categoria/.test(x)),
                );
            } finally {
                await pool.query("UPDATE productos SET categoria = $1 WHERE id = $2", [
                    A.catInsumo,
                    p.id,
                ]);
            }
        }
    });

    it("el filtro --empresas acota: la contaminación entre A y B no aparece si se audita otra empresa", async () => {
        const revertir = await ESCENARIOS[1].inyectar();
        try {
            assert.ok((await auditoria({ empresas: IDS })).hallazgos.length > 0);
            assert.deepEqual((await auditoria({ empresas: [1] })).hallazgos, []);
        } finally {
            await revertir();
        }
    });

    it("es de SOLO LECTURA: todo lo que ejecuta es SELECT, dentro de una transacción READ ONLY que termina en ROLLBACK", async () => {
        const sentencias = [];
        const poolRegistrador = {
            connect: async () => {
                const c = await pool.connect();
                return {
                    query: (sql, params) => (
                        sentencias.push(String(sql).trim()),
                        c.query(sql, params)
                    ),
                    release: () => c.release(),
                };
            },
        };
        await auditarSoloLectura(poolRegistrador, { empresas: IDS });
        assert.ok(sentencias.length > 100);
        assert.match(sentencias[0], /^BEGIN READ ONLY/);
        assert.equal(sentencias.at(-1).replace(/\s+/g, " ").split(" ")[0] === "ROLLBACK", true);
        const noLectura = sentencias.filter(
            (s) => !/^(SELECT|WITH|BEGIN READ ONLY|ROLLBACK)\b/i.test(s),
        );
        assert.deepEqual(noLectura, [], "el audit emitió algo que no es de lectura");
        // Y aunque lo intentara, Postgres lo impide dentro de esa transacción.
        const c = await pool.connect();
        try {
            await c.query("BEGIN READ ONLY");
            await assert.rejects(
                c.query("UPDATE empresas SET nombre = nombre WHERE id = $1", [A.id]),
                /read-only transaction/,
            );
        } finally {
            await c.query("ROLLBACK");
            c.release();
        }
    });

    it("no se le escapa ninguna columna *_id sin clave foránea: todas están en SIN_FK o POLIMORFICAS", async () => {
        const sinFk = (
            await pool.query(
                `SELECT c.table_name, c.column_name FROM information_schema.columns c
                 JOIN information_schema.tables t USING (table_schema, table_name)
                 WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name LIKE '%\\_id' AND c.column_name <> 'empresa_id'
                   AND NOT EXISTS (
                     SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                     WHERE k.contype = 'f' AND k.conrelid = format('public.%I', c.table_name)::regclass AND a.attname = c.column_name)`,
            )
        ).rows.map((x) => `${x.table_name}.${x.column_name}`);
        const cubiertas = new Set([...SIN_FK, ...POLIMORFICAS].map((r) => `${r.hija}.${r.col}`));
        const sueltas = sinFk.filter((c) => !cubiertas.has(c));
        assert.deepEqual(
            sueltas,
            [],
            `columnas *_id sin FK que audit:tenant no revisa; agrégalas a SIN_FK o POLIMORFICAS en scripts/audit_tenant.js:\n${sueltas.join("\n")}`,
        );
    });

    it("el comando sale con 0 si está limpio y con 1 si hay contaminación, y con --json imprime el informe", async () => {
        const correr = () =>
            spawnSync(
                process.execPath,
                ["scripts/audit_tenant.js", "--json", `--empresas=${IDS.join(",")}`],
                { env: { ...process.env, DATABASE_URL: DB }, encoding: "utf8" },
            );
        const limpio = correr();
        assert.equal(limpio.status, 0, limpio.stderr);
        assert.deepEqual(JSON.parse(limpio.stdout.slice(limpio.stdout.indexOf("{"))).hallazgos, []);
        const revertir = await ESCENARIOS[1].inyectar();
        try {
            const sucio = correr();
            assert.equal(sucio.status, 1, sucio.stdout + sucio.stderr);
            assert.match(sucio.stdout, /productos\.proveedor_id → proveedores\.id/);
        } finally {
            await revertir();
        }
    });

    it("package.json expone el comando npm run audit:tenant", () => {
        assert.equal(
            JSON.parse(readFileSync("package.json", "utf8")).scripts["audit:tenant"],
            "node scripts/audit_tenant.js",
        );
    });
});

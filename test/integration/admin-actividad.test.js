import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import { descubrirAlcance, limpiarEmpresas } from "../helpers/alcance.js";
import { tomarCompartido } from "../helpers/exclusion.js";

// Bitácora de acciones administrativas (admin_actividad), por el camino real: cada acción deja UNA fila con quién, sobre qué, desde dónde y el
// mismo id de petición del log; nunca con secretos; solo se inserta (la app no puede reescribirla) y no cruza entre empresas.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("bitácora de acciones administrativas (API real)", { skip: SKIP }, () => {
    const [A, B, C] = [9941, 9942, 9943];
    const IDS = [A, B, C];
    const sufijo = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const PIN = "7391";
    const CLAVE_NUEVA = "ClaveNuevaSecreta-4455";
    let server, base, pool, alcance, signToken, candado, registrarActividad;
    let ownerA, ownerB, adminB, meseroA, maestro;
    const creadas = []; // empresas que crean las pruebas de plataforma

    const correo = (p) => `${p}-${sufijo}@bitacora.test`;
    const mkUsuario = async (empresa, codigo, o = {}) => {
        const { owner = false, admin = owner, plataforma = false, rol = null } = o;
        const rolId = rol
            ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id
            : null;
        return (
            await pool.query(
                `INSERT INTO usuarios (nombre,codigo_ingreso,email,is_admin,is_owner,is_platform_admin,empresa_id,role_id)
                 VALUES ($1,$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                [`bit-${codigo}`, correo(codigo), admin, owner, plataforma, empresa, rolId],
            )
        ).rows[0].id;
    };
    const tok = (id, empresa) => signToken({ id, empresa_id: empresa, tv: 0 });
    let contador = 0;
    /** Hace la petición con un X-Request-Id propio y devuelve también ese id (debe quedar en la fila). */
    const http = async (metodo, ruta, { token, body } = {}) => {
        const requestId = `bitacora-${sufijo}-${++contador}`;
        const res = await fetch(base + ruta, {
            method: metodo,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                "X-Request-Id": requestId,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const texto = await res.text();
        let json = null;
        try {
            json = JSON.parse(texto);
        } catch {
            /* sin cuerpo */
        }
        return { status: res.status, json, requestId };
    };
    /** Filas de la bitácora de una petición (por su id). */
    const filas = async (requestId) =>
        (
            await pool.query("SELECT * FROM admin_actividad WHERE request_id = $1 ORDER BY id", [
                requestId,
            ])
        ).rows;
    /** Una sola fila de esa petición, ya comprobada su forma común. */
    async function unaFila(r, { accion, empresa, actor, actorEmpresa, objetoTipo }) {
        assert.ok(r.status < 300, `la acción falló: ${r.status} ${JSON.stringify(r.json)}`);
        const f = await filas(r.requestId);
        assert.equal(f.length, 1, `se esperaba UNA fila para ${accion}; hay ${f.length}`);
        assert.equal(f[0].accion, accion);
        assert.equal(f[0].empresa_id, empresa, "empresa afectada");
        assert.equal(f[0].actor_id, actor, "quién");
        assert.equal(
            f[0].actor_empresa_id,
            actorEmpresa ?? empresa,
            "empresa activa de quien actuó",
        );
        assert.equal(f[0].objeto_tipo, objetoTipo);
        assert.ok(f[0].ip, "lleva la ip");
        assert.ok(f[0].creado_at instanceof Date);
        return f[0];
    }
    const sinSecretos = (fila, ...secretos) => {
        const texto = JSON.stringify(fila);
        for (const s of secretos)
            assert.equal(texto.includes(s), false, `la bitácora guardó «${s}»`);
    };

    before(async () => {
        candado = await tomarCompartido();
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ registrarActividad } = await import("../../src/modules/actividad/actividad.js"));
        ({ server, base } = await iniciarServidor(app));
        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, IDS, alcance);
        for (const id of IDS)
            await pool.query("INSERT INTO empresas (id, nombre) VALUES ($1, $2)", [
                id,
                `Bitácora ${id}`,
            ]);
        ownerA = await mkUsuario(A, "ownA", { owner: true });
        ownerB = await mkUsuario(B, "ownB", { owner: true });
        adminB = await mkUsuario(B, "admB", { admin: true });
        meseroA = await mkUsuario(A, "mesA", { rol: "mesero" });
        maestro = await mkUsuario(C, "mae", { owner: true, plataforma: true });
    });

    after(async () => {
        mock.restoreAll();
        await limpiarEmpresas(pool, [...IDS, ...creadas], alcance);
        await pool.end();
        await new Promise((r) => server.close(r));
        await candado?.liberar();
    });

    beforeEach(() => mock.restoreAll());

    describe("usuarios", () => {
        it("usuario.crear: una fila con quién, qué, la ip y el MISMO id de petición; sin la contraseña", async () => {
            const r = await http("POST", `/api/usuarios/${A}`, {
                token: tok(ownerA, A),
                body: {
                    nombre: "Nuevo",
                    codigo_ingreso: `NU${sufijo}`.slice(0, 20),
                    email: correo("nuevo"),
                    password: CLAVE_NUEVA,
                    is_admin: false,
                },
            });
            const f = await unaFila(r, {
                accion: "usuario.crear",
                empresa: A,
                actor: ownerA,
                objetoTipo: "usuario",
            });
            assert.equal(f.objeto_id, r.json.data.id);
            assert.deepEqual(f.detalle, {
                is_admin: false,
                role_id: null,
                con_correo: true,
                con_contrasena: true,
            });
            assert.equal(f.request_id, r.requestId);
            sinSecretos(f, CLAVE_NUEVA);
        });

        it("usuario.actualizar: solo los NOMBRES de los campos y las banderas, nunca la contraseña", async () => {
            const r = await http("PUT", `/api/usuarios/${A}/${meseroA}`, {
                token: tok(ownerA, A),
                body: {
                    nombre: "Mesero Renombrado",
                    codigo_ingreso: `ME${sufijo}`.slice(0, 20),
                    activo: true,
                    password: CLAVE_NUEVA,
                    forzar_cierre_sesion: true,
                },
            });
            const f = await unaFila(r, {
                accion: "usuario.actualizar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "usuario",
            });
            assert.equal(f.objeto_id, meseroA);
            assert.deepEqual(f.detalle.campos.sort(), ["activo", "codigo_ingreso", "nombre"]);
            assert.deepEqual(
                Object.keys(f.detalle).sort(),
                ["activo", "campos", "cierre_sesiones_forzado", "contrasena_cambiada"],
                "el detalle no lleva más claves que estas",
            );
            assert.equal(f.detalle.activo, true);
            assert.equal(f.detalle.contrasena_cambiada, true);
            assert.equal(f.detalle.cierre_sesiones_forzado, true);
            sinSecretos(f, CLAVE_NUEVA);
        });

        it("un cambio rechazado (400) no deja fila", async () => {
            const r = await http("PUT", `/api/usuarios/${A}/${ownerA}`, {
                token: tok(ownerA, A),
                body: { nombre: "x", codigo_ingreso: "x", activo: false },
            });
            assert.equal(r.status, 400);
            assert.equal((await filas(r.requestId)).length, 0);
        });
    });

    describe("PIN y equipos", () => {
        let equipo;
        it("pin.definir, pin.quitar y pin.desbloquear: sin el PIN", async () => {
            const t = tok(ownerA, A);
            const d = await http("PUT", `/api/usuarios/${A}/${meseroA}/pin`, {
                token: t,
                body: { pin: PIN },
            });
            const f1 = await unaFila(d, {
                accion: "pin.definir",
                empresa: A,
                actor: ownerA,
                objetoTipo: "usuario",
            });
            assert.equal(f1.objeto_id, meseroA);
            sinSecretos(f1, PIN);
            const u = await http("POST", `/api/usuarios/${A}/${meseroA}/pin/desbloquear`, {
                token: t,
            });
            await unaFila(u, {
                accion: "pin.desbloquear",
                empresa: A,
                actor: ownerA,
                objetoTipo: "usuario",
            });
            const q = await http("DELETE", `/api/usuarios/${A}/${meseroA}/pin`, { token: t });
            await unaFila(q, {
                accion: "pin.quitar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "usuario",
            });
        });

        it("equipo.crear (sin el código), equipo.actualizar, equipo.codigo_nuevo y equipo.revocar", async () => {
            const t = tok(ownerA, A);
            const c = await http("POST", `/api/dispositivos/${A}`, {
                token: t,
                body: { nombre: "Equipo de bitácora" },
            });
            const f = await unaFila(c, {
                accion: "equipo.crear",
                empresa: A,
                actor: ownerA,
                objetoTipo: "equipo",
            });
            equipo = c.json.data.dispositivo.id;
            assert.equal(f.objeto_id, equipo);
            assert.deepEqual(f.detalle, { nombre: "Equipo de bitácora" });
            sinSecretos(f, c.json.data.codigo);

            const n = await http("PUT", `/api/dispositivos/${A}/${equipo}`, {
                token: t,
                body: { nombre: "Renombrado" },
            });
            const f2 = await unaFila(n, {
                accion: "equipo.actualizar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "equipo",
            });
            assert.deepEqual(f2.detalle, { campos: ["nombre"], nombre: "Renombrado" });

            const k = await http("POST", `/api/dispositivos/${A}/${equipo}/codigo`, { token: t });
            const f3 = await unaFila(k, {
                accion: "equipo.codigo_nuevo",
                empresa: A,
                actor: ownerA,
                objetoTipo: "equipo",
            });
            sinSecretos(f3, k.json.data.codigo);

            const rv = await http("POST", `/api/dispositivos/${A}/${equipo}/revocar`, { token: t });
            const f4 = await unaFila(rv, {
                accion: "equipo.revocar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "equipo",
            });
            assert.equal(f4.objeto_id, equipo);
        });
    });

    describe("agentes de impresión", () => {
        it("crear (sin token ni código), actualizar, código, rotar token y eliminar", async () => {
            const t = tok(ownerA, A);
            const c = await http("POST", `/api/pos/${A}/agentes`, {
                token: t,
                body: { nombre: "Caja 1" },
            });
            const f = await unaFila(c, {
                accion: "agente.crear",
                empresa: A,
                actor: ownerA,
                objetoTipo: "agente",
            });
            const id = c.json.data.agente.id;
            assert.equal(f.objeto_id, id);
            sinSecretos(f, c.json.data.token, c.json.data.codigo);

            const u = await http("PUT", `/api/pos/${A}/agentes/${id}`, {
                token: t,
                body: { nombre: "Caja 2", activo: false },
            });
            const f2 = await unaFila(u, {
                accion: "agente.actualizar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "agente",
            });
            assert.deepEqual(f2.detalle.campos.sort(), ["activo", "nombre"]);
            assert.equal(f2.detalle.activo, false);
            await http("PUT", `/api/pos/${A}/agentes/${id}`, { token: t, body: { activo: true } });

            const cod = await http("POST", `/api/pos/${A}/agentes/${id}/codigo`, { token: t });
            sinSecretos(
                await unaFila(cod, {
                    accion: "agente.codigo",
                    empresa: A,
                    actor: ownerA,
                    objetoTipo: "agente",
                }),
                cod.json.data.codigo,
            );

            const rot = await http("POST", `/api/pos/${A}/agentes/${id}/rotar-token`, { token: t });
            sinSecretos(
                await unaFila(rot, {
                    accion: "agente.rotar_token",
                    empresa: A,
                    actor: ownerA,
                    objetoTipo: "agente",
                }),
                rot.json.data.token,
            );

            const del = await http("DELETE", `/api/pos/${A}/agentes/${id}`, { token: t });
            await unaFila(del, {
                accion: "agente.eliminar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "agente",
            });
        });
    });

    describe("configuración de la empresa", () => {
        it("empresa.configuracion_actualizar al guardar; una lectura NO deja fila", async () => {
            const t = tok(ownerA, A);
            const r = await http("PUT", `/api/empresas/${A}/configuracion?aplicar_a_recetas=0`, {
                token: t,
                body: { iva_pct: 16 },
            });
            const f = await unaFila(r, {
                accion: "empresa.configuracion_actualizar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "empresa",
            });
            assert.equal(f.objeto_id, A);
            assert.deepEqual(f.detalle, { campos: ["iva_pct"], aplicar_a_recetas: false });
            const lectura = await http("GET", `/api/empresas/${A}/configuracion`, { token: t });
            assert.equal(lectura.status, 200);
            assert.equal(
                (await filas(lectura.requestId)).length,
                0,
                "leer no es una acción administrativa",
            );
            const lista = await http("GET", `/api/usuarios/${A}`, { token: t });
            assert.equal((await filas(lista.requestId)).length, 0);
        });
    });

    describe("acceso compartido y plataforma", () => {
        it("acceso.conceder y acceso.retirar (por el maestro y por el Owner de la empresa): la empresa afectada es la DESTINO y quien actúa queda aparte", async () => {
            const tM = tok(maestro, C);
            const conc = await http("PUT", `/api/platform/usuarios/${adminB}/empresas/${A}`, {
                token: tM,
                body: {},
            });
            const f = await unaFila(conc, {
                accion: "acceso.conceder",
                empresa: A,
                actor: maestro,
                actorEmpresa: C,
                objetoTipo: "usuario",
            });
            assert.equal(f.objeto_id, adminB);
            assert.equal(f.detalle.por, "maestro");
            const porOwner = await http("DELETE", `/api/usuarios/${A}/${adminB}/acceso`, {
                token: tok(ownerA, A),
            });
            const f2 = await unaFila(porOwner, {
                accion: "acceso.retirar",
                empresa: A,
                actor: ownerA,
                objetoTipo: "usuario",
            });
            assert.equal(f2.detalle.por, "owner");
            await http("PUT", `/api/platform/usuarios/${adminB}/empresas/${A}`, {
                token: tM,
                body: {},
            });
            const porMaestro = await http(
                "DELETE",
                `/api/platform/usuarios/${adminB}/empresas/${A}`,
                { token: tM },
            );
            const f3 = await unaFila(porMaestro, {
                accion: "acceso.retirar",
                empresa: A,
                actor: maestro,
                actorEmpresa: C,
                objetoTipo: "usuario",
            });
            assert.equal(f3.detalle.por, "maestro");
        });

        it("plataforma.empresa_crear: DENTRO de la transacción; luego estado, invitación y restablecer contraseña", async () => {
            const tM = tok(maestro, C);
            // Sin contraseña: el Owner recibe una invitación (así se prueba también el reenvío).
            const c = await http("POST", "/api/platform/empresas", {
                token: tM,
                body: {
                    empresa: { nombre: `Creada por bitácora ${sufijo}` },
                    owner: {
                        nombre: "Dueño",
                        email: correo("dueno"),
                        codigo_ingreso: `DU${sufijo}`.slice(0, 20),
                    },
                },
            });
            assert.equal(c.status, 201, JSON.stringify(c.json));
            const nueva = c.json.data.empresa.id;
            creadas.push(nueva);
            const ownerNuevo = c.json.data.owner.id;
            const f = await unaFila(c, {
                accion: "plataforma.empresa_crear",
                empresa: nueva,
                actor: maestro,
                actorEmpresa: C,
                objetoTipo: "empresa",
            });
            assert.equal(f.objeto_id, nueva);
            assert.deepEqual(f.detalle, { owner_id: ownerNuevo, invitacion: true });

            const e = await http("PATCH", `/api/platform/empresas/${nueva}/estado`, {
                token: tM,
                body: { activo: false },
            });
            const fe = await unaFila(e, {
                accion: "plataforma.empresa_estado",
                empresa: nueva,
                actor: maestro,
                actorEmpresa: C,
                objetoTipo: "empresa",
            });
            assert.deepEqual(fe.detalle, { activo: false });
            await http("PATCH", `/api/platform/empresas/${nueva}/estado`, {
                token: tM,
                body: { activo: true },
            });

            const inv = await http("POST", `/api/platform/empresas/${nueva}/reenviar-invitacion`, {
                token: tM,
            });
            await unaFila(inv, {
                accion: "plataforma.invitacion_reenviar",
                empresa: nueva,
                actor: maestro,
                actorEmpresa: C,
                objetoTipo: "empresa",
            });

            const rp = await http("POST", `/api/platform/empresas/${nueva}/resetear-password`, {
                token: tM,
                body: { password: CLAVE_NUEVA },
            });
            const fr = await unaFila(rp, {
                accion: "plataforma.owner_password_resetear",
                empresa: nueva,
                actor: maestro,
                actorEmpresa: C,
                objetoTipo: "usuario",
            });
            assert.equal(fr.objeto_id, ownerNuevo);
            sinSecretos(fr, CLAVE_NUEVA);
        });

        it("si la bitácora no se puede escribir, la empresa NO se crea (misma transacción: nada queda sin registrar)", async () => {
            const original = pool.connect.bind(pool);
            mock.method(pool, "connect", async () => {
                const cliente = await original();
                const q = cliente.query.bind(cliente);
                const liberar = cliente.release.bind(cliente);
                cliente.query = (sql, ...resto) =>
                    typeof sql === "string" && sql.includes("INSERT INTO admin_actividad")
                        ? Promise.reject(new Error("bitácora caída"))
                        : q(sql, ...resto);
                // El cliente vuelve al pool: hay que quitarle la sustitución o seguiría fallando para quien lo reciba después.
                cliente.release = (...args) => {
                    delete cliente.query;
                    delete cliente.release;
                    return liberar(...args);
                };
                return cliente;
            });
            const nombre = `No debe existir ${sufijo}`;
            mock.method(console, "error", () => {});
            const r = await http("POST", "/api/platform/empresas", {
                token: tok(maestro, C),
                body: {
                    empresa: { nombre },
                    owner: {
                        nombre: "Dueño",
                        email: correo("fantasma"),
                        password: CLAVE_NUEVA,
                        codigo_ingreso: "FANT",
                    },
                },
            });
            mock.restoreAll();
            assert.equal(r.status, 500);
            assert.equal(
                (await pool.query("SELECT 1 FROM empresas WHERE nombre = $1", [nombre])).rowCount,
                0,
                "la empresa se revirtió",
            );
            assert.equal(
                (await pool.query("SELECT 1 FROM usuarios WHERE email = $1", [correo("fantasma")]))
                    .rowCount,
                0,
                "el Owner también",
            );
            assert.equal((await filas(r.requestId)).length, 0);
        });
    });

    describe("si la bitácora falla en una acción SIN transacción propia", () => {
        it("la acción ya hecha se mantiene, no se reintenta, y el fallo queda en el log como admin_actividad_fallida", async () => {
            const original = pool.query.bind(pool);
            mock.method(pool, "query", (sql, ...resto) =>
                typeof sql === "string" && sql.includes("INSERT INTO admin_actividad")
                    ? Promise.reject(new Error("bitácora caída"))
                    : original(sql, ...resto),
            );
            const lineas = [];
            mock.method(console, "log", (l) => lineas.push(String(l)));
            mock.method(console, "error", (l) => lineas.push(String(l)));
            const r = await http("POST", `/api/usuarios/${A}`, {
                token: tok(ownerA, A),
                body: {
                    nombre: "Sin bitácora",
                    codigo_ingreso: `SB${sufijo}`.slice(0, 20),
                    email: correo("sinbit"),
                    is_admin: false,
                },
            });
            await new Promise((x) => setTimeout(x, 60));
            mock.restoreAll();
            assert.equal(r.status, 201, "el alta se hizo");
            assert.equal(
                (await pool.query("SELECT 1 FROM usuarios WHERE email = $1", [correo("sinbit")]))
                    .rowCount,
                1,
            );
            assert.equal((await filas(r.requestId)).length, 0, "la fila falta");
            const aviso = lineas
                .map((l) => {
                    try {
                        return JSON.parse(l);
                    } catch {
                        return null;
                    }
                })
                .find((l) => l?.message === "admin_actividad_fallida");
            assert.ok(aviso, "queda constancia en el log");
            assert.equal(aviso.accion, "usuario.crear");
            assert.equal(String(aviso.empresa_id), String(A));
            assert.equal(aviso.requestId, r.requestId);
        });
    });

    describe("solo inserción y aislamiento", () => {
        it("la app no puede actualizar, borrar ni vaciar la bitácora (permiso denegado)", async () => {
            const id = await registrarActividad(
                pool,
                {
                    actor_id: ownerA,
                    actor_empresa_id: A,
                    ip: "127.0.0.1",
                    request_id: "solo-insercion-1234",
                },
                { empresa_id: A, accion: "usuario.crear", objeto_tipo: "usuario", objeto_id: 1 },
            );
            for (const sql of [
                "UPDATE admin_actividad SET accion = 'usuario.actualizar' WHERE id = $1",
                "DELETE FROM admin_actividad WHERE id = $1",
            ]) {
                await assert.rejects(pool.query(sql, [id]), (e) => e.code === "42501", sql);
            }
            await assert.rejects(pool.query("TRUNCATE admin_actividad"), (e) => e.code === "42501");
            const sigue = await pool.query("SELECT accion FROM admin_actividad WHERE id = $1", [
                id,
            ]);
            assert.equal(sigue.rows[0].accion, "usuario.crear", "la fila sigue intacta");
        });

        it("el contrato de la tabla: acción con forma válida y detalle objeto; una acción desconocida ni se intenta", async () => {
            const ctx = { actor_id: null, actor_empresa_id: null, ip: null, request_id: null };
            await assert.rejects(
                registrarActividad(pool, ctx, {
                    empresa_id: A,
                    accion: "inventada.accion",
                    objeto_tipo: "x",
                }),
                /desconocida/,
            );
            await assert.rejects(
                pool.query(
                    "INSERT INTO admin_actividad (empresa_id, accion, objeto_tipo) VALUES ($1, 'MAL FORMADA', 'x')",
                    [A],
                ),
                (e) => e.code === "23514",
            );
            await assert.rejects(
                pool.query(
                    "INSERT INTO admin_actividad (empresa_id, accion, objeto_tipo, detalle) VALUES ($1, 'a.b', 'x', '[1]')",
                    [A],
                ),
                (e) => e.code === "23514",
            );
        });

        it("si alguien intenta meter un secreto en el detalle, se tapa antes de guardar", async () => {
            const id = await registrarActividad(
                pool,
                { actor_id: ownerA, actor_empresa_id: A, ip: null, request_id: "secreto-1234567" },
                {
                    empresa_id: A,
                    accion: "usuario.actualizar",
                    objeto_tipo: "usuario",
                    detalle: {
                        password: "NoDebeVerse1",
                        pin: "7391",
                        nota: "escribió a ana@correo.com",
                    },
                },
            );
            const f = (await pool.query("SELECT detalle FROM admin_actividad WHERE id = $1", [id]))
                .rows[0].detalle;
            assert.equal(f.password, "[redactado]");
            assert.equal(f.pin, "[redactado]");
            assert.equal(f.nota, "escribió a a***@correo.com");
        });

        it("un intento ajeno (B sobre A) se rechaza y NO escribe nada en la bitácora de A; las acciones de B quedan en B", async () => {
            const antesA = (
                await pool.query(
                    "SELECT count(*)::int n FROM admin_actividad WHERE empresa_id = $1",
                    [A],
                )
            ).rows[0].n;
            const ataque = await http("POST", `/api/usuarios/${A}`, {
                token: tok(ownerB, B),
                body: { nombre: "Intruso", codigo_ingreso: "INTR", is_admin: true },
            });
            assert.equal(ataque.status, 403);
            const despuesA = (
                await pool.query(
                    "SELECT count(*)::int n FROM admin_actividad WHERE empresa_id = $1",
                    [A],
                )
            ).rows[0].n;
            assert.equal(despuesA, antesA);
            assert.equal((await filas(ataque.requestId)).length, 0);

            const propio = await http("POST", `/api/usuarios/${B}`, {
                token: tok(ownerB, B),
                body: {
                    nombre: "Propio de B",
                    codigo_ingreso: `PB${sufijo}`.slice(0, 20),
                    email: correo("propiob"),
                    is_admin: false,
                },
            });
            const f = await unaFila(propio, {
                accion: "usuario.crear",
                empresa: B,
                actor: ownerB,
                objetoTipo: "usuario",
            });
            assert.equal(f.empresa_id, B);
            const enA = await pool.query(
                "SELECT 1 FROM admin_actividad WHERE request_id = $1 AND empresa_id = $2",
                [propio.requestId, A],
            );
            assert.equal(enA.rowCount, 0, "la acción de B no aparece en la bitácora de A");
        });
    });
});

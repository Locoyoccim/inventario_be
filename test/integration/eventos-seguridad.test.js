import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { iniciarServidor } from "../helpers/servidor.js";
import { descubrirAlcance, limpiarEmpresas } from "../helpers/alcance.js";
import { tomarCompartido } from "../helpers/exclusion.js";

// Cada evento de seguridad, por su camino real contra la API: lo que un atacante o un error de uso provoca deja UNA línea `security`
// con nombre estable, ip, usuario y empresa de la petición, y nunca con contraseñas, PIN ni tokens.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("eventos de seguridad (API real)", { skip: SKIP }, () => {
    const [A, B, C] = [9931, 9932, 9933];
    const IDS = [A, B, C];
    const sufijo = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const CLAVE = "ClaveDeLaPrueba-123";
    const PIN = "7391";
    let server, base, pool, alcance, signToken, candado, invalidarUsuarioActivo;
    let ownerA, ownerB, operativoA, meseroA, maestro, hashClave;

    const correo = (p) => `${p}-${sufijo}@eventos.test`.toLowerCase();
    const mkUsuario = async (empresa, codigo, o = {}) => {
        const {
            owner = false,
            admin = owner,
            plataforma = false,
            conClave = false,
            rol = null,
        } = o;
        const rolId = rol
            ? (await pool.query("SELECT id FROM roles WHERE clave = $1", [rol])).rows[0].id
            : null;
        return (
            await pool.query(
                `INSERT INTO usuarios (nombre,codigo_ingreso,email,password_hash,is_admin,is_owner,is_platform_admin,empresa_id,role_id)
                 VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
                [
                    `ev-${codigo}`,
                    correo(codigo),
                    conClave ? hashClave : null,
                    admin,
                    owner,
                    plataforma,
                    empresa,
                    rolId,
                ],
            )
        ).rows[0].id;
    };
    const tok = (id, empresa, extra = {}) =>
        signToken({ id, empresa_id: empresa, tv: 0, ...extra });

    const http = async (metodo, ruta, { token, cookie, body, csrf = true, headers = {} } = {}) => {
        const res = await fetch(base + ruta, {
            method: metodo,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...(csrf ? { "X-Requested-With": "XMLHttpRequest" } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const texto = await res.text();
        let json = null;
        try {
            json = JSON.parse(texto);
        } catch {
            /* sin cuerpo JSON */
        }
        return { status: res.status, json, cookies: res.headers.getSetCookie() };
    };

    /** Ejecuta `fn` y devuelve los eventos `security` que se escribieron, más todas las líneas de log como texto. */
    async function eventos(fn) {
        const lineas = [];
        const crudo = [];
        const f = (l) => {
            crudo.push(String(l));
            try {
                lineas.push(JSON.parse(l));
            } catch {
                /* línea que no es JSON */
            }
        };
        mock.method(console, "log", f);
        mock.method(console, "error", f);
        try {
            await fn();
            await new Promise((r) => setTimeout(r, 60)); // el log de la petición se escribe al terminar la respuesta
        } finally {
            mock.restoreAll();
        }
        return { eventos: lineas.filter((l) => l.message === "security"), texto: crudo.join("\n") };
    }
    const unico = (lista, nombre) => {
        const hay = lista.filter((e) => e.evento === nombre);
        assert.equal(
            hay.length,
            1,
            `se esperaba UN «${nombre}»; salieron: ${lista.map((e) => e.evento)}`,
        );
        return hay[0];
    };

    before(async () => {
        candado = await tomarCompartido();
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        ({ signToken } = await import("../../src/utils/jwt.js"));
        ({ invalidarUsuarioActivo } = await import("../../src/middlewares/activeUser.js"));
        ({ server, base } = await iniciarServidor(app));
        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, IDS, alcance);
        for (const id of IDS)
            await pool.query("INSERT INTO empresas (id, nombre) VALUES ($1, $2)", [
                id,
                `Eventos ${id}`,
            ]);
        hashClave = await bcrypt.hash(CLAVE, 4);
        ownerA = await mkUsuario(A, "ownA", { owner: true, conClave: true });
        ownerB = await mkUsuario(B, "ownB", { owner: true });
        operativoA = await mkUsuario(A, "opeA");
        meseroA = await mkUsuario(A, "mesA", { rol: "mesero" });
        maestro = await mkUsuario(C, "mae", { owner: true, plataforma: true });
    });

    after(async () => {
        await limpiarEmpresas(pool, IDS, alcance);
        await pool.end();
        await new Promise((r) => server.close(r));
        await candado?.liberar();
    });

    describe("acceso con correo y contraseña", () => {
        it("login_fallido: usuario inexistente y clave incorrecta, con el motivo solo en el log y la misma respuesta", async () => {
            const inexistente = await eventos(async () => {
                const r = await http("POST", "/api/auth/login", {
                    body: { email: `nadie-${sufijo}@eventos.test`, password: "Cualquiera123" },
                });
                assert.equal(r.status, 401);
                assert.equal(r.json.error, "Credenciales inválidas");
            });
            const e1 = unico(inexistente.eventos, "login_fallido");
            assert.equal(e1.motivo, "usuario_inexistente");
            assert.equal(e1.usuario_id, null);
            assert.match(e1.correo, /^n\*\*\*@eventos\.test$/);
            assert.ok(e1.ip && e1.requestId, "lleva ip y requestId");
            assert.equal(e1.status, 401);

            const mala = await eventos(async () => {
                const r = await http("POST", "/api/auth/login", {
                    body: { email: correo("ownA"), password: "ClaveEquivocada-9" },
                });
                assert.equal(r.status, 401);
                assert.equal(
                    r.json.error,
                    "Credenciales inválidas",
                    "no delata si el correo existe",
                );
            });
            const e2 = unico(mala.eventos, "login_fallido");
            assert.equal(e2.motivo, "clave_incorrecta");
            assert.equal(e2.usuario_id, ownerA);
            assert.equal(mala.texto.includes("ClaveEquivocada-9"), false);
        });

        it("una contraseña pegada en el campo del correo no se registra", async () => {
            const { eventos: ev, texto } = await eventos(async () => {
                await http("POST", "/api/auth/login", {
                    body: { email: "MiClaveSecreta-777", password: "x" },
                });
            });
            assert.equal(unico(ev, "login_fallido").correo, "[no es un correo]");
            assert.equal(texto.includes("MiClaveSecreta-777"), false);
        });

        it("login_bloqueado: clave correcta pero la cuenta o la empresa están desactivadas", async () => {
            const bloqueado = await mkUsuario(A, "bloq", { conClave: true });
            await pool.query("UPDATE usuarios SET activo = false WHERE id = $1", [bloqueado]);
            const r1 = await eventos(async () => {
                const r = await http("POST", "/api/auth/login", {
                    body: { email: correo("bloq"), password: CLAVE },
                });
                assert.equal(r.status, 403);
            });
            const e1 = unico(r1.eventos, "login_bloqueado");
            assert.equal(e1.motivo, "usuario_desactivado");
            assert.equal(e1.usuario_id, bloqueado);

            await pool.query("UPDATE usuarios SET activo = true WHERE id = $1", [bloqueado]);
            await pool.query("UPDATE empresas SET activo = false WHERE id = $1", [A]);
            try {
                const r2 = await eventos(async () => {
                    const r = await http("POST", "/api/auth/login", {
                        body: { email: correo("bloq"), password: CLAVE },
                    });
                    assert.equal(r.status, 403);
                });
                assert.equal(unico(r2.eventos, "login_bloqueado").motivo, "empresa_desactivada");
            } finally {
                await pool.query("UPDATE empresas SET activo = true WHERE id = $1", [A]);
            }
        });

        it("password_actual_incorrecta: cambio de contraseña con la actual equivocada", async () => {
            const { eventos: ev, texto } = await eventos(async () => {
                const r = await http("PUT", "/api/auth/password", {
                    token: tok(ownerA, A),
                    body: {
                        password_actual: "ActualEquivocada-1",
                        password_nueva: "NuevaClave-98765",
                    },
                });
                assert.equal(r.status, 400);
            });
            const e = unico(ev, "password_actual_incorrecta");
            assert.equal(e.usuario_id, ownerA);
            assert.equal(texto.includes("ActualEquivocada-1"), false);
            assert.equal(texto.includes("NuevaClave-98765"), false);
        });

        it("invitacion_invalida y setup_token_invalido", async () => {
            const inv = await eventos(async () => {
                const r = await http("GET", "/api/auth/invitacion/enlace-que-no-existe");
                assert.equal(r.status, 404);
            });
            unico(inv.eventos, "invitacion_invalida");

            process.env.SETUP_TOKEN = "setup-secreto-de-prueba";
            try {
                const setup = await eventos(async () => {
                    const r = await http("POST", "/api/auth/setup", {
                        headers: { "X-Setup-Token": "otro-valor-equivocado" },
                        body: {
                            empresa_id: A,
                            nombre: "X",
                            email: correo("setup"),
                            password: "UnaClaveLarga-1234",
                            codigo_ingreso: "SET1",
                            puesto: "Dueño",
                            role_id: 1,
                        },
                    });
                    assert.equal(r.status, 403);
                });
                unico(setup.eventos, "setup_token_invalido");
                assert.equal(setup.texto.includes("otro-valor-equivocado"), false);
            } finally {
                delete process.env.SETUP_TOKEN;
            }
        });
    });

    describe("la sesión", () => {
        it("token_invalido: un token alterado", async () => {
            const { eventos: ev, texto } = await eventos(async () => {
                const r = await http("GET", `/api/productos/${A}`, { token: "esto.no.es-un-jwt" });
                assert.equal(r.status, 401);
            });
            unico(ev, "token_invalido");
            assert.equal(texto.includes("esto.no.es-un-jwt"), false);
        });

        it("csrf_faltante: escritura con la cookie y sin la cabecera anti-CSRF", async () => {
            const { eventos: ev } = await eventos(async () => {
                const r = await http("POST", `/api/categorias/${A}`, {
                    cookie: `gh_session=${tok(ownerA, A)}`,
                    csrf: false,
                    body: { nombre: "X", tipo: "PRODUCTO" },
                });
                assert.equal(r.status, 403);
            });
            assert.equal(unico(ev, "csrf_faltante").status, 403);
        });

        it("sesion_revocada: token de una sesión que ya se cerró", async () => {
            const { eventos: ev } = await eventos(async () => {
                const r = await http("GET", `/api/productos/${A}`, {
                    token: signToken({ id: ownerA, empresa_id: A, tv: 99 }),
                });
                assert.equal(r.status, 401);
            });
            assert.equal(unico(ev, "sesion_revocada").usuario_id, ownerA);
        });

        it("usuario_desactivado y empresa_desactivada", async () => {
            const baja = await mkUsuario(A, "baja");
            await pool.query("UPDATE usuarios SET activo = false WHERE id = $1", [baja]);
            const u = await eventos(async () => {
                const r = await http("GET", `/api/productos/${A}`, { token: tok(baja, A) });
                assert.equal(r.status, 401);
            });
            unico(u.eventos, "usuario_desactivado");

            await pool.query("UPDATE empresas SET activo = false WHERE id = $1", [B]);
            invalidarUsuarioActivo(ownerB);
            try {
                const e = await eventos(async () => {
                    const r = await http("GET", `/api/productos/${B}`, { token: tok(ownerB, B) });
                    assert.equal(r.status, 401);
                });
                unico(e.eventos, "empresa_desactivada");
            } finally {
                await pool.query("UPDATE empresas SET activo = true WHERE id = $1", [B]);
                invalidarUsuarioActivo(ownerB);
            }
        });

        it("sesion_empresa_invalida: el token apunta a una empresa que no es de la persona ni tiene acceso", async () => {
            const { eventos: ev } = await eventos(async () => {
                const r = await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) });
                assert.equal(r.status, 401);
            });
            const e = unico(ev, "sesion_empresa_invalida");
            assert.equal(e.usuario_id, ownerA);
        });

        it("cambio_empresa_denegado: pedir cambiar a una empresa sin acceso", async () => {
            const { eventos: ev } = await eventos(async () => {
                const r = await http("POST", "/api/auth/empresa-activa", {
                    token: tok(ownerA, A),
                    body: { empresa_id: B },
                });
                assert.equal(r.status, 403);
            });
            const e = unico(ev, "cambio_empresa_denegado");
            assert.equal(e.motivo, "sin_acceso");
            assert.equal(e.destino, B);
        });
    });

    describe("aislamiento entre empresas y permisos", () => {
        it("empresa_ajena: un token de A pide los datos de B", async () => {
            const { eventos: ev } = await eventos(async () => {
                const r = await http("GET", `/api/productos/${B}`, { token: tok(ownerA, A) });
                assert.equal(r.status, 403);
            });
            const e = unico(ev, "empresa_ajena");
            assert.equal(e.empresa_solicitada, String(B));
            assert.equal(e.empresa_id, A, "la empresa del token queda en el contexto");
            assert.equal(e.usuario_id, ownerA);
        });

        it("permiso_denegado: un operativo en una ruta de administrador, y un no-maestro en una de plataforma", async () => {
            const a = await eventos(async () => {
                const r = await http("GET", `/api/dispositivos/${A}`, {
                    token: tok(operativoA, A),
                });
                assert.equal(r.status, 403);
            });
            const e1 = unico(a.eventos, "permiso_denegado");
            assert.equal(e1.requiere, "admin");
            assert.equal(e1.usuario_id, operativoA);

            const p = await eventos(async () => {
                const r = await http("GET", "/api/platform/empresas", { token: tok(ownerA, A) });
                assert.equal(r.status, 403);
            });
            assert.equal(unico(p.eventos, "permiso_denegado").requiere, "plataforma");
        });

        it("recurso_ajeno: un token de A pide una receta que es de B", async () => {
            await pool.query(
                "INSERT INTO categorias (empresa_id, nombre, tipo) VALUES ($1, 'Platos', 'RECETA')",
                [B],
            );
            const recetaB = (
                await pool.query(
                    "INSERT INTO recetas (nombre, categoria, empresa_id) VALUES ('Receta de B', 'Platos', $1) RETURNING id",
                    [B],
                )
            ).rows[0].id;
            const { eventos: ev } = await eventos(async () => {
                const r = await http("GET", `/api/recetas/${recetaB}/detalle`, {
                    token: tok(ownerA, A),
                });
                assert.equal(r.status, 403);
            });
            const e = unico(ev, "recurso_ajeno");
            assert.equal(e.recurso, "receta");
            assert.equal(e.empresa_id, A);
        });

        it("supervisor_credenciales_invalidas: credenciales equivocadas al autorizar", async () => {
            const { resolverAutorizador } =
                await import("../../src/modules/pos/pos.autorizacion.js");
            const intento = (creds) =>
                resolverAutorizador(A, { puedeAutorizar: false }, creds).then(
                    () => null,
                    (e) => e,
                );
            const e1 = await intento({ email: correo("fantasma"), password: "x" });
            assert.equal(e1.evento, "supervisor_credenciales_invalidas");
            assert.equal(e1.eventoDatos.motivo, "usuario_inexistente");
            const e2 = await intento({ email: correo("ownA"), password: "ClaveEquivocada-9" });
            assert.equal(e2.eventoDatos.motivo, "clave_incorrecta");
            assert.equal(e2.eventoDatos.supervisor_id, ownerA);
            assert.equal(JSON.stringify(e2.eventoDatos).includes("ClaveEquivocada"), false);
        });
    });

    describe("PIN y equipos", () => {
        let equipoId, cookieEquipo;
        const entrar = (usuario_id, pin, cookie = cookieEquipo) =>
            http("POST", "/api/auth/pin", { cookie, body: { usuario_id, pin } });

        before(async () => {
            const tokOwner = tok(ownerA, A);
            const c = await http("POST", `/api/dispositivos/${A}`, {
                token: tokOwner,
                body: { nombre: "Equipo eventos" },
            });
            assert.equal(c.status, 201, JSON.stringify(c.json));
            const canje = await http("POST", "/api/auth/dispositivo/registrar", {
                body: { codigo: c.json.data.codigo },
            });
            assert.equal(canje.status, 200);
            equipoId = c.json.data.dispositivo.id;
            cookieEquipo = canje.cookies.find((x) => x.startsWith("gh_device=")).split(";")[0];
            const p = await http("PUT", `/api/usuarios/${A}/${meseroA}/pin`, {
                token: tokOwner,
                body: { pin: PIN },
            });
            assert.equal(p.status, 200, JSON.stringify(p.json));
        });

        it("sesion_pin_invalida: equipo revocado, persona ascendida a administradora y empresa compartida", async () => {
            // Equipo revocado: la sesión de PIN deja de valer en cuanto el equipo se revoca.
            const c = await http("POST", `/api/dispositivos/${A}`, {
                token: tok(ownerA, A),
                body: { nombre: "Equipo a revocar" },
            });
            await http("POST", "/api/auth/dispositivo/registrar", {
                body: { codigo: c.json.data.codigo },
            });
            const aRevocar = c.json.data.dispositivo.id;
            const sesionPin = tok(meseroA, A, { pin: true, disp: aRevocar });
            const viva = await http("GET", `/api/productos/${A}`, { token: sesionPin });
            assert.equal(viva.status, 200, "control: antes de revocar la sesión de PIN vale");
            const rev = await http("POST", `/api/dispositivos/${A}/${aRevocar}/revocar`, {
                token: tok(ownerA, A),
            });
            assert.equal(rev.status, 200, JSON.stringify(rev.json));
            const r1 = await eventos(async () => {
                const r = await http("GET", `/api/productos/${A}`, { token: sesionPin });
                assert.equal(r.status, 401);
            });
            const e1 = unico(r1.eventos, "sesion_pin_invalida");
            assert.equal(e1.motivo, "equipo_revocado");
            assert.equal(e1.equipo, aRevocar);
            assert.equal(e1.usuario_id, meseroA);

            // Persona ascendida a administradora: una sesión de PIN nunca hereda poderes de Admin.
            const ascendido = await mkUsuario(A, "asc", { admin: true });
            const r2 = await eventos(async () => {
                const r = await http("GET", `/api/productos/${A}`, {
                    token: tok(ascendido, A, { pin: true, disp: equipoId }),
                });
                assert.equal(r.status, 401);
            });
            assert.equal(unico(r2.eventos, "sesion_pin_invalida").motivo, "ascendido_a_admin");

            // Empresa compartida: el PIN y el equipo son de la empresa base y no valen en otra.
            await pool.query(
                "INSERT INTO usuario_empresas (usuario_id, empresa_id, is_admin) VALUES ($1, $2, false)",
                [meseroA, B],
            );
            invalidarUsuarioActivo(meseroA);
            try {
                const r3 = await eventos(async () => {
                    const r = await http("GET", `/api/productos/${B}`, {
                        token: tok(meseroA, B, { pin: true, disp: equipoId }),
                    });
                    assert.equal(r.status, 401);
                });
                assert.equal(unico(r3.eventos, "sesion_pin_invalida").motivo, "empresa_compartida");
            } finally {
                await pool.query("DELETE FROM usuario_empresas WHERE usuario_id = $1", [meseroA]);
                invalidarUsuarioActivo(meseroA);
            }
        });

        it("equipo_codigo_invalido y equipo_no_registrado", async () => {
            const c = await eventos(async () => {
                const r = await http("POST", "/api/auth/dispositivo/registrar", {
                    body: { codigo: "ZZZZ-ZZZZ" },
                });
                assert.equal(r.status, 400);
            });
            unico(c.eventos, "equipo_codigo_invalido");

            const n = await eventos(async () => {
                const r = await entrar(meseroA, PIN, null); // `null` = sin cookie de equipo
                assert.equal(r.status, 401);
            });
            assert.equal(unico(n.eventos, "equipo_no_registrado").motivo, "sin_cookie");
        });

        it("pin_fallido: la persona no elegible y la que se equivoca; el PIN tecleado nunca se registra", async () => {
            const sinPin = await eventos(async () => {
                assert.equal((await entrar(operativoA, "5821")).status, 401);
            });
            assert.equal(unico(sinPin.eventos, "pin_fallido").motivo, "no_elegible");
            assert.equal(sinPin.texto.includes("5821"), false);

            const mal = await eventos(async () => {
                const r = await entrar(meseroA, "2468");
                assert.equal(r.status, 401);
                assert.equal(r.json.error, "PIN incorrecto");
            });
            const e = unico(mal.eventos, "pin_fallido");
            assert.equal(e.motivo, "pin_incorrecto");
            assert.equal(e.usuario_id, meseroA);
            assert.equal(e.equipo, equipoId);
            assert.equal(e.bloqueado_ahora, false);
            assert.equal(mal.texto.includes("2468"), false);
        });

        it("pin_en_espera tras varios fallos y pin_bloqueado cuando el fallo número 10 lo bloquea", async () => {
            const envejecer = () =>
                pool.query(
                    "UPDATE pin_fallos SET created_at = created_at - interval '10 minutes' WHERE empresa_id = $1",
                    [A],
                );
            const todos = [];
            let enEspera = 0;
            for (let i = 0; i < 40 && !todos.some((e) => e.evento === "pin_bloqueado"); i++) {
                const { eventos: ev } = await eventos(async () => {
                    await entrar(meseroA, "1357");
                });
                todos.push(...ev);
                if (ev.some((e) => e.evento === "pin_en_espera")) {
                    enEspera++;
                    await envejecer();
                }
            }
            assert.ok(enEspera >= 1, "hubo al menos un enfriamiento");
            const espera = todos.find((e) => e.evento === "pin_en_espera");
            assert.ok(espera.espera_seg > 0);
            assert.equal(espera.status, 429);
            assert.ok(
                todos.some((e) => e.evento === "pin_fallido" && e.bloqueado_ahora === true),
                "el fallo que bloquea lo dice",
            );
            const bloqueado = unico(todos, "pin_bloqueado");
            assert.equal(bloqueado.usuario_id, meseroA);
            assert.equal(bloqueado.status, 429);
            assert.equal(
                todos.some((e) => "pin" in e && e.pin !== "[redactado]"),
                false,
            );
        });
    });

    describe("agente de impresión", () => {
        it("agente_token_invalido (sin token y con token falso) y agente_codigo_invalido", async () => {
            const sin = await eventos(async () => {
                assert.equal((await http("GET", "/api/agente/version")).status, 401);
            });
            assert.equal(unico(sin.eventos, "agente_token_invalido").motivo, "sin_token");

            const falso = await eventos(async () => {
                const r = await http("GET", "/api/agente/version", {
                    token: "gh_agt_0000000000000000000000000000000000000000",
                });
                assert.equal(r.status, 401);
            });
            const e = unico(falso.eventos, "agente_token_invalido");
            assert.equal(e.motivo, "invalido_o_desactivado");
            assert.equal(falso.texto.includes("gh_agt_0000"), false);

            const cod = await eventos(async () => {
                const r = await http("POST", "/api/agente/emparejar", {
                    body: { codigo: "ZZZZ-ZZZZ-ZZZZ" },
                });
                assert.equal(r.status, 400);
            });
            unico(cod.eventos, "agente_codigo_invalido");
        });
    });

    describe("acceso compartido entre empresas", () => {
        it("concesión y retiro (por el maestro y por el Owner de la empresa) dejan su evento, a nivel info", async () => {
            const tMaestro = tok(maestro, C);
            const conc = await eventos(async () => {
                const r = await http("PUT", `/api/platform/usuarios/${ownerA}/empresas/${B}`, {
                    token: tMaestro,
                    body: {},
                });
                assert.equal(r.status, 200, JSON.stringify(r.json));
            });
            const e1 = unico(conc.eventos, "acceso_compartido_concedido");
            assert.equal(e1.level, "info");
            assert.equal(e1.usuario_destino, ownerA);
            assert.equal(e1.empresa_destino, B);
            assert.equal(e1.usuario_id, maestro, "quién lo hizo");

            const porOwner = await eventos(async () => {
                const r = await http("DELETE", `/api/usuarios/${B}/${ownerA}/acceso`, {
                    token: tok(ownerB, B),
                });
                assert.equal(r.status, 200, JSON.stringify(r.json));
            });
            const e2 = unico(porOwner.eventos, "acceso_compartido_retirado");
            assert.equal(e2.por, "owner");
            assert.equal(e2.usuario_id, ownerB);

            await http("PUT", `/api/platform/usuarios/${ownerA}/empresas/${B}`, {
                token: tMaestro,
                body: {},
            });
            const porMaestro = await eventos(async () => {
                const r = await http("DELETE", `/api/platform/usuarios/${ownerA}/empresas/${B}`, {
                    token: tMaestro,
                });
                assert.equal(r.status, 200, JSON.stringify(r.json));
            });
            assert.equal(unico(porMaestro.eventos, "acceso_compartido_retirado").por, "maestro");
        });

        it("una persona a la que le retiraron el acceso pierde la sesión con evento sesion_empresa_invalida", async () => {
            const tMaestro = tok(maestro, C);
            await http("PUT", `/api/platform/usuarios/${ownerA}/empresas/${B}`, {
                token: tMaestro,
                body: {},
            });
            await http("DELETE", `/api/platform/usuarios/${ownerA}/empresas/${B}`, {
                token: tMaestro,
            });
            const { eventos: ev } = await eventos(async () => {
                const r = await http("GET", `/api/productos/${B}`, { token: tok(ownerA, B) });
                assert.equal(r.status, 401);
            });
            unico(ev, "sesion_empresa_invalida");
        });
    });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import {
    descubrirAlcance,
    huellaEmpresas,
    diferencias,
    limpiarEmpresas,
} from "../helpers/alcance.js";
import { tomarCompartido } from "../helpers/exclusion.js";
import { EmpresaPrueba } from "../helpers/empresaCompleta.js";

// Fase 5 · caminos que NO pasan por empresaGuard con un JWT de usuario: nadie debe asumir que la guardia por parámetro los cubre.
//   · Agente de impresión (token propio gh_agt_…, fija su empresa)
//   · PIN en equipos registrados (cookie del equipo + PIN)
//   · SSE /eventos (flujo de avisos por LISTEN/NOTIFY, filtrado por empresa en el servidor)
//   · Idempotencia (llaves del POS, compartibles por accidente entre empresas)
// Cada bloque tiene su CONTROL (la empresa dueña sí obtiene lo suyo) para no pasar en vacío.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Aislamiento multiempresa — caminos sin JWT de usuario", { skip: SKIP }, () => {
    const IDS = [9871, 9872];
    let server, base, pool, alcance, A, B, reiniciarEventos;
    const abiertos = [];

    /** Petición cruda (sin Authorization por omisión): agente, cookie de equipo, etc. */
    const f = async (metodo, ruta, { token, cookie, body } = {}) => {
        const res = await fetch(base + ruta, {
            method: metodo,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                "X-Requested-With": "XMLHttpRequest",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
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
        return { status: res.status, texto, json, cookies: res.headers.getSetCookie() };
    };
    const huellaA = () => huellaEmpresas(pool, [A.id], alcance);

    let candado;
    before(async () => {
        // Antes de leer el esquema: otro archivo puede estar ejecutando algo global (ver test/helpers/exclusion.js).
        candado = await tomarCompartido();
        const { default: app } = await import("../../src/app.js");
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        ({ reiniciarEventos } = await import("../../src/realtime/eventosPos.js"));
        reiniciarEventos();
        ({ server, base } = await iniciarServidor(app));
        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, IDS, alcance);
        A = await new EmpresaPrueba({ id: IDS[0], etiqueta: "A", base, pool, signToken }).iniciar();
        B = await new EmpresaPrueba({ id: IDS[1], etiqueta: "B", base, pool, signToken }).iniciar();
    });

    after(async () => {
        for (const s of abiertos) s.cerrar?.();
        await limpiarEmpresas(pool, IDS, alcance);
        const { cerrarEventos } = await import("../../src/realtime/eventosPos.js");
        await cerrarEventos();
        await pool.end();
        await new Promise((r) => server.close(r));
        await candado?.liberar();
    });

    // ───────────────────────────── Agente de impresión ─────────────────────────────
    describe("agente de impresión (token gh_agt_…)", () => {
        let tokA, tokB;

        before(async () => {
            for (const E of [A, B]) {
                const ag = await E.nuevo("agente");
                const canje = await f("POST", "/api/agente/emparejar", {
                    body: { codigo: ag.codigo, equipo: `PC ${E.etiqueta}` },
                });
                assert.equal(canje.status, 200, canje.texto);
                if (E === A) tokA = canje.json.data.token;
                else tokB = canje.json.data.token;
                await E.nuevo("cuentaEnviada"); // trabajos PENDIENTES de esa empresa, con su marcador en el contenido
            }
        });

        it("el agente de B no recibe trabajos de A; el de A sí recibe los suyos (control)", async () => {
            const antes = await huellaA();
            const rb = await f("GET", "/api/agente/impresiones/pendientes", { token: tokB });
            assert.equal(rb.status, 200, rb.texto);
            assert.ok(rb.json.data.length > 0, "control: B debe recibir sus propios trabajos");
            assert.ok(rb.texto.includes(B.marca), "los trabajos de B llevan su marcador");
            assert.ok(!rb.texto.includes(A.marca), "el agente de B recibió datos de A");
            assert.deepEqual(
                diferencias(antes, await huellaA()),
                {},
                "el agente de B tocó los trabajos de A",
            );

            const ra = await f("GET", "/api/agente/impresiones/pendientes", { token: tokA });
            assert.equal(ra.status, 200);
            assert.ok(ra.texto.includes(A.marca), "control: el agente de A recibe lo suyo");
            assert.ok(!ra.texto.includes(B.marca));
        });

        it("el agente de B no puede reportar el resultado de un trabajo de A; el de A sí (control)", async () => {
            // Los trabajos de A ya están IMPRIMIENDO (los reclamó su agente): el atacante conoce el id.
            const trabajoA = (
                await pool.query(
                    "SELECT id FROM pos_impresiones WHERE empresa_id = $1 AND estado = 'IMPRIMIENDO' ORDER BY id LIMIT 1",
                    [A.id],
                )
            ).rows[0];
            assert.ok(trabajoA, "fixture: A debe tener un trabajo IMPRIMIENDO");
            const antes = await huellaA();
            const r = await f("POST", `/api/agente/impresiones/${trabajoA.id}/resultado`, {
                token: tokB,
                body: { ok: true },
            });
            assert.equal(r.status, 404, r.texto);
            assert.deepEqual(
                diferencias(antes, await huellaA()),
                {},
                "B cambió el estado de un trabajo de A",
            );
            const rc = await f("POST", `/api/agente/impresiones/${trabajoA.id}/resultado`, {
                token: tokA,
                body: { ok: true },
            });
            assert.equal(rc.status, 200, rc.texto);
        });

        it("el token del agente no abre la API de usuarios y el JWT de usuario no abre la del agente", async () => {
            const sesion = await f("GET", `/api/pos/${A.id}/impresiones`, { token: tokA });
            assert.equal(sesion.status, 401, "un token de agente no es una sesión");
            for (const ruta of ["/api/agente/version", "/api/agente/impresiones/pendientes"]) {
                assert.equal(
                    (await f("GET", ruta, { token: A.tokAdmin })).status,
                    401,
                    `${ruta} con un JWT de usuario`,
                );
                assert.equal(
                    (await f("GET", ruta, { token: "gh_agt_" + "0".repeat(48) })).status,
                    401,
                    `${ruta} con un token inventado`,
                );
                assert.equal((await f("GET", ruta)).status, 401, `${ruta} sin token`);
            }
        });

        it("un agente desactivado o con token rotado deja de funcionar", async () => {
            const nuevo = await B.nuevo("agente");
            const canje = await f("POST", "/api/agente/emparejar", {
                body: { codigo: nuevo.codigo },
            });
            const tok = canje.json.data.token;
            assert.equal((await f("GET", "/api/agente/version", { token: tok })).status, 200);
            await B.crear("PUT", `/api/pos/${B.id}/agentes/${nuevo.id}`, { activo: false });
            assert.equal(
                (await f("GET", "/api/agente/version", { token: tok })).status,
                401,
                "desactivado",
            );
            await B.crear("PUT", `/api/pos/${B.id}/agentes/${nuevo.id}`, { activo: true });
            await B.crear("POST", `/api/pos/${B.id}/agentes/${nuevo.id}/rotar-token`, {});
            assert.equal(
                (await f("GET", "/api/agente/version", { token: tok })).status,
                401,
                "token rotado",
            );
        });

        it("el código de emparejamiento es de un solo uso y uno inventado no sirve", async () => {
            const ag = await A.nuevo("agente");
            const antes = await huellaA();
            assert.equal(
                (await f("POST", "/api/agente/emparejar", { body: { codigo: "ZZZZ-ZZZZ" } }))
                    .status,
                400,
            );
            const primero = await f("POST", "/api/agente/emparejar", {
                body: { codigo: ag.codigo },
            });
            assert.equal(primero.status, 200);
            assert.equal(
                (await f("POST", "/api/agente/emparejar", { body: { codigo: ag.codigo } })).status,
                400,
                "el código no se reutiliza",
            );
            const mia = await f("GET", "/api/agente/impresiones/pendientes", {
                token: primero.json.data.token,
            });
            assert.ok(
                !mia.texto.includes(B.marca),
                "el agente emparejado con un código de A no ve datos de B",
            );
            assert.notDeepEqual(
                antes,
                await huellaA(),
                "control: canjear el código sí cambia el agente de A (el canje es de A)",
            );
        });
    });

    // ───────────────────────────── PIN en equipos registrados ─────────────────────────────
    describe("PIN en equipos registrados (cookie del equipo)", () => {
        const PIN = "4827";
        let cookieA, cookieB, meseroA, meseroB;

        const registrar = async (E) => {
            const dev = await E.nuevo("dispositivo");
            const canje = await f("POST", "/api/auth/dispositivo/registrar", {
                body: { codigo: dev.codigo },
            });
            assert.equal(canje.status, 200, canje.texto);
            return canje.cookies.find((c) => c.startsWith("gh_device=")).split(";")[0];
        };
        const conPin = async (E) => {
            const rol = (await pool.query("SELECT id FROM roles WHERE clave = 'mesero'")).rows[0]
                .id;
            const u = await E.crear("POST", `/api/usuarios/${E.id}`, {
                nombre: `${E.marca}-pin`,
                codigo_ingreso: `pin-${E.etiqueta}-${Date.now()}`,
                role_id: rol,
            });
            await E.crear("PUT", `/api/usuarios/${E.id}/${u.id}/pin`, { pin: PIN });
            return u;
        };
        const entrar = (cookie, usuario_id, pin) =>
            f("POST", "/api/auth/pin", { cookie, body: { usuario_id, pin } });

        before(async () => {
            cookieA = await registrar(A);
            cookieB = await registrar(B);
            meseroA = await conPin(A);
            meseroB = await conPin(B);
        });

        it("la lista de personal de un equipo solo trae gente de SU empresa", async () => {
            const lb = await f("GET", "/api/auth/dispositivo/personal", { cookie: cookieB });
            assert.equal(lb.status, 200);
            assert.ok(lb.texto.includes(B.marca), "control: el equipo de B lista a su personal");
            assert.ok(!lb.texto.includes(A.marca), "el equipo de B lista personal de A");
            const la = await f("GET", "/api/auth/dispositivo/personal", { cookie: cookieA });
            assert.ok(la.texto.includes(A.marca) && !la.texto.includes(B.marca));
        });

        it("un equipo de B no entra como un usuario de A aunque el PIN sea correcto, y no se distingue de un usuario inexistente", async () => {
            const antes = await huellaA();
            const ajeno = await entrar(cookieB, meseroA.id, PIN);
            const inexistente = await entrar(cookieB, 2147483000, PIN);
            assert.ok(
                ajeno.status === 401 || ajeno.status === 403,
                `entró o falló raro: ${ajeno.status} ${ajeno.texto}`,
            );
            assert.ok(
                !ajeno.cookies.some((c) => c.startsWith("gh_session=")),
                "se emitió sesión para un usuario de otra empresa",
            );
            assert.equal(
                ajeno.status,
                inexistente.status,
                "la respuesta delata que el usuario existe en otra empresa",
            );
            assert.equal(ajeno.texto, inexistente.texto);
            assert.deepEqual(
                diferencias(antes, await huellaA()),
                {},
                "los intentos desde el equipo de B dejaron huella en datos de A",
            );
        });

        it("B no puede bloquear a un usuario de A fallando su PIN desde un equipo de B", async () => {
            const antes = await huellaA();
            for (let i = 0; i < 8; i++) await entrar(cookieB, meseroA.id, "0000");
            assert.deepEqual(
                diferencias(antes, await huellaA()),
                {},
                "los fallos desde B dejaron huella en datos de A",
            );
            const bloqueado = (
                await pool.query("SELECT pin_bloqueado_at FROM usuarios WHERE id = $1", [
                    meseroA.id,
                ])
            ).rows[0].pin_bloqueado_at;
            assert.equal(
                bloqueado,
                null,
                "el usuario de A quedó bloqueado por intentos hechos desde B",
            );
            const ok = await entrar(cookieA, meseroA.id, PIN);
            assert.equal(ok.status, 200, `control: A entra con su PIN y su equipo (${ok.texto})`);
        });

        it("la sesión de PIN es de la empresa del usuario y no abre la URL de otra", async () => {
            const ok = await entrar(cookieB, meseroB.id, PIN);
            assert.equal(ok.status, 200, ok.texto);
            const sesion = ok.cookies.find((c) => c.startsWith("gh_session=")).split(";")[0];
            assert.equal(
                (await f("GET", `/api/pos/${B.id}/mapa`, { cookie: sesion })).status,
                200,
                "control: su propia empresa",
            );
            const cruzada = await f("GET", `/api/pos/${A.id}/mapa`, { cookie: sesion });
            assert.equal(cruzada.status, 403);
            assert.ok(!cruzada.texto.includes(A.marca));
        });

        it("el PIN de A tampoco sirve con el equipo de B para un usuario de B que no lo tiene definido", async () => {
            const sinPin = await B.nuevo("usuario");
            const r = await entrar(cookieB, sinPin.id, PIN);
            assert.equal(r.status, 401);
        });
    });

    // ───────────────────────────── SSE /eventos ─────────────────────────────
    describe("flujo de avisos SSE (/api/pos/:empresa_id/eventos)", () => {
        async function flujo(E, ruta = `/api/pos/${E.id}/eventos`, token = E.tokAdmin) {
            const control = new AbortController();
            const res = await fetch(base + ruta, {
                headers: { Authorization: `Bearer ${token}` },
                signal: control.signal,
            });
            const salida = { status: res.status, eventos: [], texto: "" };
            if (res.status !== 200) {
                salida.texto = await res.text();
                return salida;
            }
            const lector = res.body.getReader();
            const dec = new TextDecoder();
            let resto = "";
            (async () => {
                try {
                    for (;;) {
                        const { done, value } = await lector.read();
                        if (done) break;
                        const trozo = dec.decode(value, { stream: true });
                        salida.texto += trozo;
                        resto += trozo;
                        let i;
                        while ((i = resto.indexOf("\n\n")) >= 0) {
                            const linea = resto
                                .slice(0, i)
                                .split("\n")
                                .find((l) => l.startsWith("data: "));
                            resto = resto.slice(i + 2);
                            if (linea) salida.eventos.push(JSON.parse(linea.slice(6)));
                        }
                    }
                } catch {
                    /* abortado */
                }
            })();
            salida.cerrar = () => control.abort();
            abiertos.push(salida);
            return salida;
        }
        const esperar = async (s, pred, ms = 3000) => {
            const hasta = Date.now() + ms;
            while (Date.now() < hasta) {
                const e = s.eventos.find(pred);
                if (e) return e;
                await new Promise((r) => setTimeout(r, 25));
            }
            return null;
        };
        const quieto = (ms = 400) => new Promise((r) => setTimeout(r, ms));

        it("B no puede suscribirse al flujo de A", async () => {
            const r = await flujo(B, `/api/pos/${A.id}/eventos`);
            assert.equal(r.status, 403);
            assert.ok(!r.texto.includes(A.marca));
            const sinToken = await fetch(base + `/api/pos/${A.id}/eventos`);
            assert.equal(sinToken.status, 401);
            await sinToken.body?.cancel();
        });

        it("cada flujo recibe solo los avisos de su empresa", async () => {
            const sa = await flujo(A);
            const sb = await flujo(B);
            assert.equal(sa.status, 200);
            assert.equal(sb.status, 200);
            await esperar(sa, (e) => e.tipo === "conectado");
            await esperar(sb, (e) => e.tipo === "conectado");
            const baseA = sa.eventos.length;
            const baseB = sb.eventos.length;

            const cuentaA = await A.nuevo("cuentaEnviada"); // genera avisos de A
            const evA = await esperar(sa, (e) => e.cuenta_id === cuentaA.id);
            assert.ok(evA, "control: el flujo de A recibe el aviso de su cuenta");
            assert.equal(Number(evA.empresa_id), A.id);
            await quieto();
            assert.equal(
                sb.eventos.length,
                baseB,
                `el flujo de B recibió avisos de A: ${JSON.stringify(sb.eventos.slice(baseB))}`,
            );

            const cuentaB = await B.nuevo("cuentaEnviada");
            const evB = await esperar(sb, (e) => e.cuenta_id === cuentaB.id);
            assert.ok(evB, "control: el flujo de B recibe el aviso de su cuenta");
            await quieto();
            const ajenosEnA = sa.eventos.slice(baseA).filter((e) => Number(e.empresa_id) !== A.id);
            assert.deepEqual(ajenosEnA, [], "el flujo de A recibió avisos de B");
            assert.ok(
                !sb.texto.includes(`"cuenta_id":${cuentaA.id},`),
                "el texto del flujo de B menciona la cuenta de A",
            );
        });
    });

    // ───────────────────────────── Idempotencia ─────────────────────────────
    describe("llaves de idempotencia (Idempotency-Key)", () => {
        const K = "clave-compartida-por-accidente-1234";
        const abrirCon = (E, mesa_id, clave = K, token) =>
            E.http("POST", `/api/pos/${E.id}/cuentas`, {
                token,
                body: { tipo: "MESA", mesa_id },
                headers: { "Idempotency-Key": clave },
            });

        it("la misma llave usada por dos empresas no mezcla respuestas: cada una obtiene y repite lo suyo", async () => {
            const mesaA = await A.nuevo("mesa");
            const mesaB = await B.nuevo("mesa");
            const ra = await abrirCon(A, mesaA.id);
            assert.equal(ra.status, 201, ra.texto);
            const antes = await huellaA();
            const rb = await abrirCon(B, mesaB.id);
            assert.equal(
                rb.status,
                201,
                `B con la misma llave debía abrir SU cuenta, no recibir la de A: ${rb.texto}`,
            );
            assert.equal(
                rb.headers.get("idempotent-replay"),
                null,
                "la respuesta de B es una repetición de la de A",
            );
            assert.notEqual(rb.json.data.id, ra.json.data.id);
            assert.equal(Number(rb.json.data.empresa_id), B.id);
            assert.ok(!rb.texto.includes(A.marca));
            assert.deepEqual(
                diferencias(antes, await huellaA()),
                {},
                "la petición de B alteró datos de A",
            );

            const repB = await abrirCon(B, mesaB.id);
            assert.equal(repB.headers.get("idempotent-replay"), "true");
            assert.equal(repB.json.data.id, rb.json.data.id, "B repite SU respuesta");
            const repA = await abrirCon(A, mesaA.id);
            assert.equal(
                repA.headers.get("idempotent-replay"),
                "true",
                "control: A repite lo suyo",
            );
            assert.equal(repA.json.data.id, ra.json.data.id);

            const filas = (
                await pool.query(
                    "SELECT empresa_id, respuesta::text AS r FROM pos_idempotencia WHERE clave = $1 ORDER BY empresa_id",
                    [K],
                )
            ).rows;
            assert.deepEqual(
                filas.map((x) => x.empresa_id),
                [A.id, B.id],
                "una reserva por empresa",
            );
            assert.ok(filas[0].r.includes(A.marca) && !filas[0].r.includes(B.marca));
            assert.ok(filas[1].r.includes(B.marca) && !filas[1].r.includes(A.marca));
        });

        it("B no puede usar una llave para recibir la respuesta guardada de A con otro cuerpo ni con ids de A", async () => {
            const mesaA = await A.nuevo("mesa");
            const k = "clave-con-ids-ajenos-123456";
            const antes = await huellaA();
            const r = await abrirCon(B, mesaA.id, k); // la mesa es de A
            assert.ok(r.status >= 400 && r.status < 500, r.texto);
            assert.ok(!r.texto.includes(A.marca));
            assert.deepEqual(diferencias(antes, await huellaA()), {});
            const guardada = (
                await pool.query("SELECT 1 FROM pos_idempotencia WHERE clave = $1", [k])
            ).rowCount;
            assert.equal(guardada, 0, "un intento fallido no deja una reserva de llave");
        });
    });
});

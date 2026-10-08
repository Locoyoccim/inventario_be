import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import { catalogoReal } from "../helpers/catalogoReal.js";
import { clasificar } from "../helpers/catalogoRutas.js";
import {
    descubrirAlcance,
    huellaEmpresas,
    diferencias,
    limpiarEmpresas,
} from "../helpers/alcance.js";
import { EmpresaPrueba, fechaRelativa } from "../helpers/empresaCompleta.js";
import { CASOS } from "../helpers/casosAislamiento.js";

// Fase 5 · prueba B — aislamiento DINÁMICO con dos empresas completas (A y B).
// Cada caso (test/helpers/casosAislamiento.js) hace la MISMA petición dos veces:
//   control → la empresa dueña, con sus propios ids: debe funcionar (2xx). Prueba que el caso es válido y no un simple error de validación.
//   ataque  → la empresa B con ids de la empresa A: debe fallar (4xx) y además
//             (1) la huella de los datos de A es idéntica antes y después,
//             (2) la respuesta no contiene ningún marcador de A.
// Requiere TEST_DATABASE_URL (BD de pruebas migrada).

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

describe("Aislamiento multiempresa — dinámico con dos empresas (prueba B)", { skip: SKIP }, () => {
    const IDS = [9861, 9862];
    let server, pool, catalogo, alcance, A, B;

    before(async () => {
        const real = await catalogoReal();
        catalogo = real.catalogo;
        ({ default: pool } = await import("../../src/config/db.js"));
        const { signToken } = await import("../../src/utils/jwt.js");
        let base;
        ({ server, base } = await iniciarServidor(real.app));
        alcance = await descubrirAlcance(pool);
        await limpiarEmpresas(pool, IDS, alcance);
        A = await new EmpresaPrueba({ id: IDS[0], etiqueta: "A", base, pool, signToken }).iniciar();
        B = await new EmpresaPrueba({ id: IDS[1], etiqueta: "B", base, pool, signToken }).iniciar();
    });

    after(async () => {
        await limpiarEmpresas(pool, IDS, alcance);
        await pool.end();
        server.close();
    });

    /** Arma la petición del caso: fabrica los recursos y resuelve la URL. `E` pide; `D` es dueña de los recursos `aj`. */
    async function preparar(caso, E, D, control = false) {
        const prin = {};
        for (const [k, tipo] of Object.entries(caso.prin)) prin[k] = await E.nuevo(tipo);
        const aj = {};
        for (const [k, tipo] of Object.entries(caso.aj)) aj[k] = await D.nuevo(tipo);
        const ctx = { aj, prin, E, D, control };
        const [metodo, plantilla] = caso.ruta.split(" ");
        const params = caso.params(ctx);
        const ruta =
            plantilla.replace(":empresa_id", String(E.id)).replace(/:([a-zA-Z_]+)/g, (_, k) => {
                assert.ok(k in params, `${caso.ruta}: el caso no define el parámetro :${k}`);
                return String(params[k]);
            }) + caso.query(ctx);
        const body = caso.body(ctx) ?? (metodo === "GET" ? undefined : {});
        return () => E.http(metodo, ruta, { token: E[caso.quien], body });
    }

    describe("cobertura del catálogo", () => {
        it("cada caso apunta a una ruta que existe, y las rutas con ids tienen al menos un caso", (t) => {
            const claves = new Set(catalogo.rutas.map((r) => `${r.metodo} ${r.ruta}`));
            const huerfanos = CASOS.filter((c) => !claves.has(c.ruta)).map((c) => c.ruta);
            assert.deepEqual(huerfanos, [], "casos que apuntan a rutas que ya no existen");

            const conCaso = new Set(CASOS.map((c) => c.ruta));
            const sinCaso = catalogo.rutas
                .filter((r) => clasificar(r)?.categoria === "tenant")
                .filter((r) => /\/:(?!empresa_id)[a-zA-Z_]+/.test(r.ruta))
                .map((r) => `${r.metodo} ${r.ruta}`)
                .filter((k) => !conCaso.has(k));
            t.diagnostic(`${CASOS.length} casos · rutas con ids sin caso: ${sinCaso.length}`);
            assert.deepEqual(
                sinCaso,
                [],
                `rutas tenant con ids que no tienen caso de aislamiento:\n${sinCaso.join("\n")}`,
            );
        });
    });

    describe("recurso de A pedido por B", () => {
        for (const caso of CASOS) {
            it(`${caso.tipo} · ${caso.ruta}`, async () => {
                // ATAQUE: B pide en SU url un recurso de A.
                const ataque = await preparar(caso, B, A);
                const antes = await huellaEmpresas(pool, [A.id], alcance);
                const r = await ataque();
                const cambios = diferencias(antes, await huellaEmpresas(pool, [A.id], alcance));
                if (caso.vacio) {
                    // Respuesta vacía por el filtro de empresa (ver el caso): 200 solo si NO trae ningún dato.
                    assert.ok(
                        r.status === 200 && caso.vacio(r.json),
                        `el ataque debía responder 4xx o un 200 vacío y respondió ${r.status}: ${r.texto.slice(0, 200)}`,
                    );
                } else {
                    assert.ok(
                        r.status >= 400 && r.status < 500,
                        `el ataque debía responder 4xx y respondió ${r.status}: ${r.texto.slice(0, 200)}`,
                    );
                }
                assert.ok(
                    !r.texto.includes(A.marca),
                    `la respuesta a B contiene datos de A: ${r.texto.slice(0, 200)}`,
                );
                assert.deepEqual(cambios, {}, "B modificó datos de A");

                // CONTROL: la empresa dueña hace la misma petición con lo suyo y funciona.
                const control = await preparar(caso, A, A, true);
                const rc = await control();
                const esperado = caso.control ?? ((s) => s >= 200 && s < 300);
                assert.ok(
                    esperado(rc.status),
                    `el control (A sobre lo suyo) debía funcionar y respondió ${rc.status}: ${rc.texto.slice(0, 300)}`,
                );
                if (caso.vacio) {
                    assert.ok(
                        !caso.vacio(rc.json),
                        "el control debía devolver filas: sin ellas, lo vacío del ataque no prueba nada",
                    );
                }
            });
        }
    });

    // Listados que exigen parámetros para responder 200.
    const QUERY_LISTADO = {
        "/api/finanzas/:empresa_id/resumen": `?desde=${fechaRelativa(-30)}&hasta=${fechaRelativa(0)}`,
    };

    describe("listados propios y campos ignorados", () => {
        const listados = () =>
            catalogo.rutas.filter(
                (r) =>
                    r.metodo === "GET" &&
                    clasificar(r)?.categoria === "tenant" &&
                    !/\/:(?!empresa_id)[a-zA-Z_]+/.test(r.ruta) &&
                    !r.ruta.endsWith("/eventos"), // el SSE no termina: se prueba aparte (caminos sin JWT)
            );

        it("los listados de B (con datos de A existentes) no traen nada de A, y los de A sí traen lo suyo", async (t) => {
            const rutas = listados();
            assert.ok(rutas.length >= 40, `se esperaban ≥40 listados, hay ${rutas.length}`);
            const fugas = [];
            const fallos = [];
            let conMarcaA = 0;
            for (const r of rutas) {
                const ruta = (E) =>
                    r.ruta.replace(":empresa_id", String(E.id)) + (QUERY_LISTADO[r.ruta] ?? "");
                const rb = await B.http("GET", ruta(B));
                if (rb.status < 200 || rb.status >= 300) fallos.push(`B ${r.ruta} → ${rb.status}`);
                if (rb.texto.includes(A.marca)) fugas.push(r.ruta);
                const ra = await A.http("GET", ruta(A));
                if (ra.status < 200 || ra.status >= 300) fallos.push(`A ${r.ruta} → ${ra.status}`);
                if (ra.texto.includes(A.marca)) conMarcaA++;
            }
            t.diagnostic(`${rutas.length} listados · A devuelve su marcador en ${conMarcaA}`);
            assert.deepEqual(fallos, [], "los listados de las dos empresas deben responder 2xx");
            assert.deepEqual(fugas, [], `listados de B con datos de A:\n${fugas.join("\n")}`);
            assert.ok(
                conMarcaA >= 15,
                `control: A debería ver su marcador en varios listados (ve ${conMarcaA}); si no, el detector está ciego`,
            );
        });

        it("el kardex ignora el usuario_id del cuerpo: el movimiento queda a nombre de quien lo hace, no de un usuario de A", async () => {
            const p = await B.nuevo("producto");
            const r = await B.http("POST", `/api/productos/${B.id}/${p.id}/movimientos`, {
                body: {
                    tipo_movimiento: "MERMA",
                    cantidad: 1,
                    motivo: "prueba",
                    usuario_id: A.adminId,
                },
            });
            assert.equal(r.status, 201, r.texto);
            const fila = (
                await pool.query("SELECT usuario_id FROM movimientosinventario WHERE id = $1", [
                    r.json.data.id,
                ])
            ).rows[0];
            assert.equal(
                fila.usuario_id,
                B.adminId,
                "el movimiento no debe poder atribuirse a un usuario de otra empresa",
            );
        });
    });
});

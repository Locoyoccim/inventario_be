import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { iniciarServidor } from "../helpers/servidor.js";
import { catalogoReal } from "../helpers/catalogoReal.js";
import { tomarCompartido } from "../helpers/exclusion.js";

// Auditoría · matriz de permisos por ruta. Es el complemento del aislamiento entre empresas: ahí se prueba que B no toca a A; aquí que,
// DENTRO de la propia empresa, una persona sin permisos no hace nada que no deba — llamando directo a la API, sin pasar por el front.
//
// Método: se toma el catálogo REAL de rutas de empresa (router de Express, no una lista escrita a mano) y se llama a cada una como un
// Operativo con un rol SIN ningún permiso. Debe responder 403 a todas, salvo las que están en ABIERTAS (con su motivo). Así:
//   · una ruta nueva sin guardia de rol/permiso hace fallar la prueba (aparece como «no esperada»);
//   · una ruta de ABIERTAS que alguien protege después también falla (la lista no se queda obsoleta);
//   · ninguna escritura queda abierta por omisión: todas las escrituras (salvo el cálculo sin efectos de la lista) deben dar 403.

process.env.NODE_ENV = "test";
const DB = process.env.TEST_DATABASE_URL;
const SKIP = !DB && "define TEST_DATABASE_URL para correrlo";
if (DB) {
    process.env.DATABASE_URL = DB;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_de_al_menos_32_caracteres_ok";
}

const CONSULTA =
    "Consulta operativa: el personal ve el catálogo y los documentos para trabajar; sin guardia de permiso por decisión de producto.";
const REVISAR =
    "ABIERTA HOY A CUALQUIER MIEMBRO — decisión de producto pendiente (dato sensible dentro de la empresa).";

/** Rutas de empresa que un Operativo sin permisos SÍ alcanza (todas son lecturas salvo el cálculo de la receta). */
const ABIERTAS = {
    "GET /api/productos/:empresa_id": CONSULTA,
    "GET /api/productos/:empresa_id/:id": CONSULTA,
    "GET /api/productos/:empresa_id/:id/uso": CONSULTA,
    "GET /api/productos/:empresa_id/:id/movimientos": CONSULTA,
    "GET /api/proveedores/:empresa_id": CONSULTA,
    "GET /api/proveedores/:empresa_id/:id/resumen": CONSULTA,
    "GET /api/recetas/:empresa_id": CONSULTA,
    "GET /api/recetas/:empresa_id/:id": CONSULTA,
    "POST /api/recetas/:empresa_id/preview":
        "Calcula costos de una receta en borrador; no guarda nada (responde 400 con un cuerpo vacío).",
    "GET /api/produccion/:empresa_id": CONSULTA,
    "GET /api/produccion/:empresa_id/:id": CONSULTA,
    "GET /api/produccion/:empresa_id/sugerencias": CONSULTA,
    "GET /api/produccion/:empresa_id/plan/:receta_id": CONSULTA,
    "GET /api/conteos/:empresa_id": CONSULTA,
    "GET /api/conteos/:empresa_id/:id": CONSULTA,
    "GET /api/conteos/:empresa_id/plantilla": CONSULTA,
    "GET /api/compras/:empresa_id": CONSULTA,
    "GET /api/compras/:empresa_id/:id": CONSULTA,
    "GET /api/categorias/:empresa_id":
        "Documentado: «cualquier usuario autenticado» (docs/API.md).",
    "GET /api/reportes/:empresa_id/estado": CONSULTA,
    "GET /api/reportes/:empresa_id/pos":
        "Señal ligera para Inicio y el menú (¿hay turnos sin cerrar?).",
    "GET /api/reportes/:empresa_id/primeros-pasos": "Avance de la puesta en marcha; solo conteos.",
    "GET /api/reportes/:empresa_id/alertas": CONSULTA,
    "GET /api/reportes/:empresa_id/inventario": `${REVISAR} Valorización del inventario (costos).`,
    "GET /api/reportes/:empresa_id/actividad": `${REVISAR} Movimientos por tipo y merma.`,
    "GET /api/reportes/:empresa_id/historial": `${REVISAR} Feed de compras, conteos y producción.`,
    "GET /api/reportes/:empresa_id/consumo": `${REVISAR} Top de consumo por ventas.`,
    "GET /api/movimientos/:empresa_id": `${REVISAR} Kardex completo de la empresa.`,
    "GET /api/finanzas/:empresa_id/categorias-gasto": CONSULTA,
    "GET /api/finanzas/:empresa_id/gastos": `${REVISAR} Gastos de la empresa.`,
    "GET /api/finanzas/:empresa_id/ingresos": `${REVISAR} Ingresos de la empresa.`,
    "GET /api/usuarios/:empresa_id": `${REVISAR} Devuelve correo, código de ingreso, rol, admin/dueño y estado del PIN de TODO el personal.`,
    "GET /api/roles/:empresa_id": CONSULTA,
};

describe(
    "Matriz de permisos — un Operativo sin permisos solo alcanza lo declarado",
    { skip: SKIP },
    () => {
        const A = 9961;
        let server, base, pool, tok, rutas, candado;

        before(async () => {
            candado = await tomarCompartido();
            const real = await catalogoReal();
            ({ default: pool } = await import("../../src/config/db.js"));
            const { signToken } = await import("../../src/utils/jwt.js");
            ({ server, base } = await iniciarServidor(real.app));
            rutas = real.catalogo.rutas.filter(
                (r) => r.router === "api" && r.ruta.includes(":empresa_id"),
            );
            await limpiar();
            await pool.query("INSERT INTO empresas (id,nombre) VALUES ($1,'Matriz permisos')", [A]);
            // Un rol sin ningún permiso. (Un Operativo SIN rol recibe los permisos heredados de compras/conteos/producción/gastos/ingresos.)
            const rolId = (
                await pool.query(
                    "INSERT INTO roles (nombre, descripcion, clave, permisos) VALUES ('Sin permisos (prueba)','prueba','matriz-sin-permisos','[]'::jsonb) RETURNING id",
                )
            ).rows[0].id;
            const uid = (
                await pool.query(
                    "INSERT INTO usuarios (nombre,codigo_ingreso,email,is_admin,is_owner,empresa_id,role_id) VALUES ('Op','MX-op','op@matriz.test',false,false,$1,$2) RETURNING id",
                    [A, rolId],
                )
            ).rows[0].id;
            tok = signToken({ id: uid, empresa_id: A, is_admin: false, is_owner: false, tv: 0 });
        });

        async function limpiar() {
            await pool.query("DELETE FROM usuarios WHERE empresa_id = $1", [A]);
            await pool.query("DELETE FROM roles WHERE clave = 'matriz-sin-permisos'");
            await pool.query("DELETE FROM empresas WHERE id = $1", [A]);
        }

        after(async () => {
            try {
                await limpiar();
            } finally {
                await candado?.liberar();
                await new Promise((r) => server.close(r));
                await pool.end();
            }
        });

        it("el catálogo real trae las rutas de empresa (la prueba no pasa por vacío)", () => {
            assert.ok(rutas.length > 120, `solo ${rutas.length} rutas de empresa`);
        });

        it("cada ruta de empresa responde 403 al Operativo sin permisos, salvo las declaradas abiertas; y las abiertas siguen abiertas", async () => {
            const abiertasHoy = [];
            for (const r of rutas) {
                const url = r.ruta.replace(":empresa_id", String(A)).replace(/:[a-zA-Z_]+/g, "1");
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), 3000);
                let estado;
                try {
                    const res = await fetch(base + url, {
                        method: r.metodo,
                        headers: {
                            Authorization: `Bearer ${tok}`,
                            "Content-Type": "application/json",
                            "X-Requested-With": "prueba",
                        },
                        body: r.metodo === "GET" ? undefined : "{}",
                        signal: ctl.signal,
                    });
                    estado = res.status;
                    await res.body?.cancel();
                } catch {
                    estado = "sin respuesta (¿flujo abierto?)";
                } finally {
                    clearTimeout(t);
                }
                if (estado !== 403) abiertasHoy.push(`${r.metodo} ${r.ruta}`);
            }
            const esperadas = Object.keys(ABIERTAS);
            const sobran = abiertasHoy.filter((k) => !esperadas.includes(k)).sort();
            const faltan = esperadas.filter((k) => !abiertasHoy.includes(k)).sort();
            assert.deepEqual(
                sobran,
                [],
                `Rutas que un Operativo sin permisos alcanza y NO están declaradas (¿falta requirePermiso/requireAdmin?):\n${sobran.join("\n")}`,
            );
            assert.deepEqual(
                faltan,
                [],
                `Rutas declaradas abiertas que ya no lo están (quítalas de ABIERTAS):\n${faltan.join("\n")}`,
            );
            const escrituras = abiertasHoy.filter((k) => !k.startsWith("GET "));
            assert.deepEqual(
                escrituras,
                ["POST /api/recetas/:empresa_id/preview"],
                "la única escritura abierta es el cálculo sin efectos",
            );
        });
    },
);

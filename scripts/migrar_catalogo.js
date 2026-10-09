#!/usr/bin/env node
// Lleva el CATÁLOGO de una empresa (proveedores, categorías y productos) de la base local a OTRA instalación (p. ej. producción), por la API
// de esa instalación: pasa por sus validaciones y su bitácora, y no hace falta abrir la base remota a internet.
//
//   npm run migrar:catalogo -- --origen 4 --destino https://<web>.up.railway.app --destino-empresa 2 --email dueno@correo.mx          (simula)
//   npm run migrar:catalogo -- --origen 4 --destino https://… --destino-empresa 2 --email dueno@correo.mx --aplicar                  (escribe)
//
// Opciones: --incluir-inactivos (por defecto se omiten los productos desactivados) · --stock-actual (por defecto el stock inicial es 0 y se
// conservan el mínimo y el máximo; con esta opción se copia el stock de la base de origen).
// La contraseña se pide por teclado sin mostrarla (o variable MIGRAR_PASSWORD); nunca se imprime ni se guarda. El origen se lee con la
// conexión de la app (.env: DATABASE_URL o DB_*) en una transacción de SOLO LECTURA.
//
// Es repetible: antes de crear, consulta lo que ya hay en el destino y omite lo que existe con el mismo nombre. Omite también los productos
// ELABORADOS (nacen de recetas: se recrean al migrar las recetas) y reporta cada omisión.
// Códigos de salida: 0 bien · 1 hubo errores al crear · 2 entrada inválida o no se pudo ingresar.
import { pathToFileURL } from "node:url";
import {
    productoCreateSchema,
    productoUpdateSchema,
} from "../src/modules/productos/productos.schema.js";
import { proveedorCreateSchema } from "../src/modules/proveedores/proveedor.schema.js";
import { categoriaCreateSchema } from "../src/modules/categorias/categoria.schema.js";

const clave = (s) =>
    String(s ?? "")
        .trim()
        .toLowerCase();
const CABECERA_CSRF = "X-Requested-With";

export class MigracionError extends Error {
    constructor(mensaje, codigo = 2) {
        super(mensaje);
        this.codigo = codigo;
    }
}

/** Lee del origen (solo lectura): lo que se va a llevar y lo que se omite, con el motivo. */
export async function leerOrigen(
    db,
    empresaId,
    { incluirInactivos = false, stockActual = false } = {},
) {
    const c = await db.connect();
    try {
        await c.query("BEGIN READ ONLY");
        const proveedores = (
            await c.query(
                "SELECT id, nombre, telefono, email, domicilio, activo FROM proveedores WHERE empresa_id = $1 ORDER BY nombre",
                [empresaId],
            )
        ).rows;
        const categorias = (
            await c.query(
                "SELECT nombre, tipo FROM categorias WHERE empresa_id = $1 AND activo ORDER BY nombre",
                [empresaId],
            )
        ).rows;
        const productos = (
            await c.query(
                `SELECT p.id, p.producto, p.unidad_medida, p.categoria, p.cantidad_presentacion, p.costo_presentacion, p.merma_pct,
                        p.precio_venta, p.compra_al_producir, p.es_elaborado, p.activo, p.proveedor_id,
                        COALESCE(i.stock_actual, 0) AS stock_actual, COALESCE(i.stock_minimo, 0) AS stock_minimo, i.stock_maximo
                   FROM productos p LEFT JOIN inventario i ON i.producto_id = p.id AND i.empresa_id = p.empresa_id
                  WHERE p.empresa_id = $1 ORDER BY p.producto`,
                [empresaId],
            )
        ).rows;
        await c.query("ROLLBACK");

        const omitidos = [];
        const llevar = [];
        for (const p of productos) {
            if (p.es_elaborado)
                omitidos.push({ producto: p.producto, motivo: "elaborado (nace de una receta)" });
            else if (!p.activo && !incluirInactivos)
                omitidos.push({ producto: p.producto, motivo: "inactivo" });
            else llevar.push(p);
        }
        const provPorId = new Map(proveedores.map((x) => [x.id, x]));
        const usados = new Set(llevar.map((p) => p.proveedor_id));
        // Solo se llevan los proveedores que algún producto a migrar necesita (un proveedor sin productos no es del catálogo).
        const provLlevar = proveedores.filter((x) => usados.has(x.id));
        const num = (v) => (v === null || v === undefined ? undefined : Number(v));
        const payloads = llevar.map((p) => {
            const minimo = Number(p.stock_minimo);
            const maximo = p.stock_maximo === null ? undefined : Number(p.stock_maximo);
            return {
                origen: p,
                proveedor_nombre: provPorId.get(p.proveedor_id)?.nombre,
                body: {
                    producto: p.producto,
                    unidad_medida: p.unidad_medida,
                    categoria: p.categoria,
                    cantidad_presentacion: Number(p.cantidad_presentacion),
                    costo_presentacion: Number(p.costo_presentacion),
                    stock_actual: stockActual ? Number(p.stock_actual) : 0,
                    stock_minimo: minimo,
                    // El máximo solo es válido si supera al mínimo: si no, se omite (el sistema ya lo trata como «sin máximo»).
                    ...(maximo !== undefined && maximo > minimo ? { stock_maximo: maximo } : {}),
                    compra_al_producir: Boolean(p.compra_al_producir),
                    merma_pct: num(p.merma_pct) ?? 0,
                    ...(p.precio_venta !== null && Number(p.precio_venta) > 0
                        ? { precio_venta: Number(p.precio_venta) }
                        : {}),
                },
            };
        });
        return { proveedores: provLlevar, categorias, productos: payloads, omitidos };
    } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
    } finally {
        c.release();
    }
}

/** Valida todo con los esquemas REALES de la app: lo que no pase aquí tampoco pasaría en el destino. Devuelve los problemas. */
export function validarPlan(plan) {
    const problemas = [];
    for (const p of plan.proveedores) {
        const r = proveedorCreateSchema.safeParse({
            nombre: p.nombre,
            ...(p.telefono ? { telefono: p.telefono } : {}),
            ...(p.email ? { email: p.email } : {}),
            ...(p.domicilio ? { domicilio: p.domicilio } : {}),
        });
        if (!r.success)
            problemas.push(
                `proveedor «${p.nombre}»: ${r.error.issues.map((i) => i.message).join("; ")}`,
            );
    }
    for (const c of plan.categorias) {
        const r = categoriaCreateSchema.safeParse({ nombre: c.nombre, tipo: c.tipo });
        if (!r.success)
            problemas.push(
                `categoría «${c.nombre}»: ${r.error.issues.map((i) => i.message).join("; ")}`,
            );
    }
    const nombresCat = new Set(plan.categorias.map((c) => clave(c.nombre)));
    for (const p of plan.productos) {
        const r = productoCreateSchema.safeParse({ ...p.body, proveedor_id: 1 });
        if (!r.success)
            problemas.push(
                `producto «${p.body.producto}»: ${r.error.issues.map((i) => i.message).join("; ")}`,
            );
        if (!nombresCat.has(clave(p.body.categoria)))
            problemas.push(
                `producto «${p.body.producto}»: su categoría «${p.body.categoria}» no está entre las categorías a migrar`,
            );
    }
    return problemas;
}

class Cliente {
    constructor(base) {
        this.base = base.replace(/\/+$/, "");
        this.cookie = null;
    }

    async pedir(metodo, ruta, cuerpo, intentos = 4) {
        for (let n = 1; ; n++) {
            const res = await fetch(`${this.base}${ruta}`, {
                method: metodo,
                headers: {
                    [CABECERA_CSRF]: "migrar-catalogo",
                    ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {}),
                    ...(this.cookie ? { Cookie: this.cookie } : {}),
                },
                body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
            });
            if (res.status === 429 && n < intentos) {
                await new Promise((r) => setTimeout(r, 1500 * n));
                continue;
            }
            const texto = await res.text();
            let json = null;
            try {
                json = JSON.parse(texto);
            } catch {
                /* sin cuerpo JSON */
            }
            return { status: res.status, json, headers: res.headers };
        }
    }

    async ingresar(email, password) {
        const r = await this.pedir("POST", "/api/auth/login", { email, password });
        if (r.status !== 200)
            throw new MigracionError(
                `No se pudo ingresar (HTTP ${r.status}): revisa el correo y la contraseña`,
            );
        const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
        const gh = sc.map((c) => c.split(";")[0]).find((c) => c.startsWith("gh_session="));
        if (!gh) throw new MigracionError("El login no entregó la cookie de sesión");
        this.cookie = gh;
        return r.json?.data?.user ?? {};
    }
}

const lista = (r) => {
    const d = r.json?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
};

/**
 * Corre la migración. `aplicar: false` (por defecto) solo lee, valida y devuelve el plan; no contacta el destino.
 * @returns {Promise<object>} informe: conteos de creados / ya existían / omitidos / errores
 */
export async function migrar({
    db,
    origenEmpresa,
    destino,
    destinoEmpresa,
    email,
    password,
    aplicar = false,
    incluirInactivos = false,
    stockActual = false,
    log = () => {},
}) {
    const plan = await leerOrigen(db, origenEmpresa, { incluirInactivos, stockActual });
    const problemas = validarPlan(plan);
    const informe = {
        plan: {
            proveedores: plan.proveedores.length,
            categorias: plan.categorias.length,
            productos: plan.productos.length,
            omitidos: plan.omitidos,
        },
        problemas,
        aplicado: false,
        creados: { proveedores: 0, categorias: 0, productos: 0 },
        existian: { proveedores: 0, categorias: 0, productos: 0 },
        errores: [],
    };
    if (problemas.length) return informe;
    if (!aplicar) return informe;

    const url = new URL(destino);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local)
        throw new MigracionError("El destino debe ser https (solo localhost puede ser http)");
    if (!email || !password)
        throw new MigracionError("Faltan el correo o la contraseña para ingresar al destino");

    const api = new Cliente(destino);
    const user = await api.ingresar(email, password);
    log(`Sesión iniciada en el destino (empresa activa ${user.empresa_id ?? "?"}).`);
    if (Number(user.empresa_id) !== Number(destinoEmpresa)) {
        const cambio = await api.pedir("POST", "/api/auth/empresa-activa", {
            empresa_id: destinoEmpresa,
        });
        if (cambio.status !== 200)
            throw new MigracionError(
                `Tu usuario no tiene acceso a la empresa ${destinoEmpresa} del destino (HTTP ${cambio.status})`,
            );
    }
    const E = destinoEmpresa;
    informe.aplicado = true;

    // 1) Proveedores
    const ya = new Map(
        lista(await api.pedir("GET", `/api/proveedores/${E}`)).map((x) => [clave(x.nombre), x.id]),
    );
    const idProveedor = new Map();
    for (const p of plan.proveedores) {
        if (ya.has(clave(p.nombre))) {
            idProveedor.set(p.id, ya.get(clave(p.nombre)));
            informe.existian.proveedores++;
            continue;
        }
        const body = {
            nombre: p.nombre,
            ...(p.telefono ? { telefono: p.telefono } : {}),
            ...(p.email ? { email: p.email } : {}),
            ...(p.domicilio ? { domicilio: p.domicilio } : {}),
        };
        const r = await api.pedir("POST", `/api/proveedores/${E}`, body);
        if (r.status === 201 || r.status === 200) {
            idProveedor.set(p.id, r.json.data.id);
            informe.creados.proveedores++;
        } else
            informe.errores.push(
                `proveedor «${p.nombre}»: HTTP ${r.status} ${r.json?.error ?? ""}`.trim(),
            );
    }

    // 2) Categorías
    const cats = new Set(
        lista(await api.pedir("GET", `/api/categorias/${E}`)).map((x) => clave(x.nombre)),
    );
    for (const c of plan.categorias) {
        if (cats.has(clave(c.nombre))) {
            informe.existian.categorias++;
            continue;
        }
        const r = await api.pedir("POST", `/api/categorias/${E}`, {
            nombre: c.nombre,
            tipo: c.tipo,
        });
        if (r.status === 201 || r.status === 200) informe.creados.categorias++;
        else
            informe.errores.push(
                `categoría «${c.nombre}»: HTTP ${r.status} ${r.json?.error ?? ""}`.trim(),
            );
    }

    // 3) Productos
    const prods = new Set(
        lista(await api.pedir("GET", `/api/productos/${E}`)).map((x) => clave(x.producto)),
    );
    for (const p of plan.productos) {
        if (prods.has(clave(p.body.producto))) {
            informe.existian.productos++;
            continue;
        }
        const proveedor_id = idProveedor.get(p.origen.proveedor_id);
        if (!proveedor_id) {
            informe.errores.push(
                `producto «${p.body.producto}»: su proveedor no se pudo crear en el destino`,
            );
            continue;
        }
        const r = await api.pedir("POST", `/api/productos/${E}`, { ...p.body, proveedor_id });
        if (r.status !== 201 && r.status !== 200) {
            informe.errores.push(
                `producto «${p.body.producto}»: HTTP ${r.status} ${r.json?.error ?? ""} ${JSON.stringify(r.json?.details ?? "")}`.trim(),
            );
            continue;
        }
        informe.creados.productos++;
        if (!p.origen.activo) {
            const { stock_actual: _s, ...resto } = p.body;
            const u = productoUpdateSchema.safeParse({ ...resto, proveedor_id, activo: false });
            const id = r.json.data.id;
            const d = u.success
                ? await api.pedir("PUT", `/api/productos/${E}/${id}`, u.data)
                : { status: 0 };
            if (d.status !== 200)
                informe.errores.push(
                    `producto «${p.body.producto}»: se creó pero no se pudo dejar inactivo (HTTP ${d.status})`,
                );
        }
    }
    return informe;
}

// ---------- línea de comandos ----------
function argumento(args, nombre) {
    const i = args.indexOf(nombre);
    return i >= 0 ? args[i + 1] : undefined;
}

function pedirContrasena(pregunta) {
    return new Promise((resolver, rechazar) => {
        if (!process.stdin.isTTY)
            return rechazar(
                new MigracionError(
                    "No hay terminal para pedir la contraseña: define MIGRAR_PASSWORD",
                ),
            );
        process.stdout.write(pregunta);
        const { stdin } = process;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let txt = "";
        const alDato = (ch) => {
            for (const c of ch) {
                if (c === "\r" || c === "\n" || c === "\u0004") {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off("data", alDato);
                    process.stdout.write("\n");
                    return resolver(txt);
                }
                if (c === "\u0003") {
                    stdin.setRawMode(false);
                    process.stdout.write("\n");
                    process.exit(130);
                }
                if (c === "\u007f") txt = txt.slice(0, -1);
                else txt += c;
            }
        };
        stdin.on("data", alDato);
    });
}

async function main() {
    const args = process.argv.slice(2);
    const origenEmpresa = Number(argumento(args, "--origen"));
    const destino = argumento(args, "--destino");
    const destinoEmpresa = Number(argumento(args, "--destino-empresa"));
    const email = argumento(args, "--email")?.trim().toLowerCase();
    const aplicar = args.includes("--aplicar");
    const { default: pool } = await import("../src/config/db.js");
    try {
        if (!Number.isInteger(origenEmpresa) || origenEmpresa <= 0)
            throw new MigracionError("Falta --origen <id de la empresa en tu base local>");
        if (aplicar) {
            if (!destino) throw new MigracionError("Falta --destino <URL de la instalación>");
            if (!Number.isInteger(destinoEmpresa) || destinoEmpresa <= 0)
                throw new MigracionError(
                    "Falta --destino-empresa <id de la empresa en el destino>",
                );
            if (!email)
                throw new MigracionError("Falta --email <correo con el que ingresas al destino>");
        }
        const password = aplicar
            ? (process.env.MIGRAR_PASSWORD ??
              (await pedirContrasena(`Contraseña de ${email} en el destino: `)))
            : undefined;
        const r = await migrar({
            db: pool,
            origenEmpresa,
            destino,
            destinoEmpresa,
            email,
            password,
            aplicar,
            incluirInactivos: args.includes("--incluir-inactivos"),
            stockActual: args.includes("--stock-actual"),
            log: console.log,
        });
        console.log(
            `migrar:catalogo — ${aplicar ? "APLICADO" : "SIMULACIÓN (no se escribió nada; usa --aplicar)"}\n` +
                `  a llevar: ${r.plan.proveedores} proveedores, ${r.plan.categorias} categorías, ${r.plan.productos} productos\n` +
                `  omitidos: ${r.plan.omitidos.length}${r.plan.omitidos.length ? " → " + [...new Set(r.plan.omitidos.map((o) => o.motivo))].map((m) => `${r.plan.omitidos.filter((o) => o.motivo === m).length} ${m}`).join(", ") : ""}`,
        );
        if (r.problemas.length) {
            console.log(`  ✖ ${r.problemas.length} problema(s) de validación (no se aplicó nada):`);
            for (const p of r.problemas.slice(0, 30)) console.log(`    · ${p}`);
            process.exitCode = 2;
        } else if (r.aplicado) {
            console.log(
                `  creados: ${r.creados.proveedores} proveedores, ${r.creados.categorias} categorías, ${r.creados.productos} productos\n` +
                    `  ya existían: ${r.existian.proveedores} proveedores, ${r.existian.categorias} categorías, ${r.existian.productos} productos`,
            );
            if (r.errores.length) {
                console.log(`  ✖ ${r.errores.length} error(es):`);
                for (const e of r.errores.slice(0, 30)) console.log(`    · ${e}`);
                process.exitCode = 1;
            }
        }
    } catch (e) {
        console.error(`migrar:catalogo — ${e.message}`);
        process.exitCode = e instanceof MigracionError ? e.codigo : 2;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

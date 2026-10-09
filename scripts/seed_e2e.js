#!/usr/bin/env node
// Siembra HERMÉTICA para las pruebas E2E (Playwright, repo del front). Parte de una base recién migrada y crea, A TRAVÉS DE LA API,
// lo mínimo para ejercitar la app real: empresa, Admin, Operativo, categorías, proveedor, insumos, recetas, mesas y áreas.
//
//   DATABASE_URL=...(rol gh_app) JWT_SECRET=... E2E_API_URL=http://127.0.0.1:4100 \
//   E2E_ADMIN_PASSWORD=... E2E_OPERATIVO_PASSWORD=... node scripts/seed_e2e.js
//
// Única excepción de SQL (no es dato de negocio): la RAÍZ de confianza. La API de plataforma exige un usuario maestro
// (`is_platform_admin`) y no existe forma de crear el primero por la API (el equivalente en producción es scripts/crear_admin.js):
// se inserta ese usuario (y su empresa «Plataforma») con el rol de la app y se firma un JWT de prueba para él. TODO lo demás
// —empresa del cliente, Owner (con el flujo real de invitación), Operativo, catálogo, POS— entra por los endpoints reales.
//
// Falla con un error claro ante cualquier respuesta inesperada. Nunca imprime contraseñas ni tokens.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { signToken } from "../src/utils/jwt.js";

export const EMAILS = {
    maestro: "maestro.e2e@gastronomyhub.test",
    admin: "admin.e2e@gastronomyhub.test",
    operativo: "operativo.e2e@gastronomyhub.test",
    // Owner de la segunda empresa (la que se comparte con el Admin): nadie entra con él, solo existe para dar de alta la empresa.
    duena: "duena.e2e@gastronomyhub.test",
};

/** Segunda empresa de la siembra: el Admin E2E tiene acceso compartido a ella (lo concede el maestro). */
export const EMPRESA_COMPARTIDA = {
    nombre: "Empresa E2E Compartida",
    producto: "Producto Compartido E2E",
};

function exigir(env, nombre, minimo = 1) {
    const v = env[nombre];
    if (!v || v.length < minimo)
        throw new Error(`Falta ${nombre}${minimo > 1 ? ` (mínimo ${minimo} caracteres)` : ""}.`);
    return v;
}

/** Cliente mínimo de la API: lanza con endpoint, estado y mensaje (sin cuerpo con secretos) si la respuesta no es 2xx. */
export function crearCliente(base, token) {
    const llamar = async (metodo, ruta, cuerpo, tokenPropio = token) => {
        const res = await fetch(base + ruta, {
            method: metodo,
            headers: {
                ...(tokenPropio ? { Authorization: `Bearer ${tokenPropio}` } : {}),
                ...(cuerpo !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
        });
        let json = null;
        try {
            json = await res.json();
        } catch {
            /* sin cuerpo */
        }
        if (!res.ok)
            throw new Error(
                `${metodo} ${ruta} → ${res.status}: ${json?.error ?? json?.message ?? "sin mensaje"}`,
            );
        return { json, headers: res.headers };
    };
    return {
        get: (ruta) => llamar("GET", ruta),
        post: (ruta, cuerpo) => llamar("POST", ruta, cuerpo ?? {}),
        put: (ruta, cuerpo) => llamar("PUT", ruta, cuerpo),
    };
}

/** Cambia la empresa activa de la sesión del cliente `api` (cookie re-firmada) y devuelve el JWT resultante. */
async function jwtDeEmpresa(api, apiUrl, empresa_id) {
    const r = await api.post("/api/auth/empresa-activa", { empresa_id });
    const jwt = decodeURIComponent(
        /gh_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "",
    );
    if (!jwt) throw new Error("empresa-activa no devolvió la cookie de sesión.");
    return jwt;
}

export async function sembrar(env = process.env, log = console.log) {
    const apiUrl = (env.E2E_API_URL || "http://127.0.0.1:4100").replace(/\/$/, "");
    const passAdmin = exigir(env, "E2E_ADMIN_PASSWORD", 8);
    const passOperativo = exigir(env, "E2E_OPERATIVO_PASSWORD", 8);
    exigir(env, "JWT_SECRET");
    const dbUrl = exigir(env, "DATABASE_URL");

    // --- Raíz de confianza (SQL mínimo, rol de la app): usuario maestro de plataforma ---
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    let maestro;
    try {
        const existe = await db.query("SELECT 1 FROM usuarios WHERE email = ANY($1)", [
            Object.values(EMAILS),
        ]);
        if (existe.rowCount > 0)
            throw new Error(
                "La base no está limpia: ya existen los usuarios E2E. La siembra solo corre sobre una base recién migrada.",
            );
        const emp = await db.query(
            "INSERT INTO empresas (nombre) VALUES ('Plataforma E2E') RETURNING id",
        );
        const u = await db.query(
            `INSERT INTO usuarios (nombre, codigo_ingreso, email, is_admin, is_owner, is_platform_admin, empresa_id)
             VALUES ('Maestro E2E', 'E2E-MAESTRO', $1, true, true, true, $2) RETURNING id, empresa_id`,
            [EMAILS.maestro, emp.rows[0].id],
        );
        maestro = u.rows[0];
    } finally {
        await db.end();
    }
    const tokMaestro = signToken({
        id: maestro.id,
        empresa_id: maestro.empresa_id,
        is_admin: true,
        is_owner: true,
        is_platform_admin: true,
        tv: 0,
    });
    const plataforma = crearCliente(apiUrl, tokMaestro);

    // --- Empresa del cliente + Owner por la API, con el flujo real de contraseña temporal (sin SQL) ---
    // (Con NODE_ENV=test el correo se simula y no devuelve el enlace de invitación, así que se usa la contraseña temporal:
    // el Owner entra y la cambia por la API, como haría un Admin real.)
    const temporal = randomBytes(12).toString("hex");
    const alta = (
        await plataforma.post("/api/platform/empresas", {
            empresa: { nombre: "Empresa E2E" },
            owner: {
                nombre: "Admin E2E",
                email: EMAILS.admin,
                codigo_ingreso: "E2E-ADMIN",
                password: temporal,
            },
        })
    ).json.data;
    const E = alta.empresa.id;
    const entrar = async (password) => {
        const r = await crearCliente(apiUrl).post("/api/auth/login", {
            email: EMAILS.admin,
            password,
        });
        const jwt = decodeURIComponent(
            /gh_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "",
        );
        if (!jwt) throw new Error("El login del Admin no devolvió la cookie de sesión.");
        return jwt;
    };
    // Con contraseña temporal solo se puede cambiarla (must_change_password); el cambio revoca esa sesión y se vuelve a entrar.
    await crearCliente(apiUrl, await entrar(temporal)).put("/api/auth/password", {
        password_actual: temporal,
        password_nueva: passAdmin,
    });
    const api = crearCliente(apiUrl, await entrar(passAdmin));
    log(`✔ empresa «Empresa E2E» (id ${E}) y Admin (contraseña temporal cambiada por la API)`);

    // --- Configuración: pantalla de cocina activa (el golden path pasa por /cocina) ---
    await api.put(`/api/empresas/${E}/configuracion`, { usa_pantalla_cocina: true });

    // --- Catálogo ---
    const categoria = async (nombre, tipo) =>
        (await api.post(`/api/categorias/${E}`, { nombre, tipo })).json.data;
    await categoria("Insumos", "PRODUCTO");
    await categoria("Bebidas", "RECETA"); // nace asignada al área Barra
    await categoria("Alimentos", "RECETA"); // sin área: cae en el área por defecto (Cocina)
    const proveedor = (await api.post(`/api/proveedores/${E}`, { nombre: "Proveedor E2E" })).json
        .data;
    const insumo = async (producto, unidad_medida, costo, cantidad = 1000) =>
        (
            await api.post(`/api/productos/${E}`, {
                producto,
                unidad_medida,
                proveedor_id: proveedor.id,
                categoria: "Insumos",
                cantidad_presentacion: cantidad,
                costo_presentacion: costo,
                stock_actual: 5000,
                stock_minimo: 100,
            })
        ).json.data;
    const cafe = await insumo("Café molido E2E", "g", 250);
    const leche = await insumo("Leche E2E", "ml", 22);
    const pan = await insumo("Pan E2E", "pieza", 40, 10);
    const receta = async (nombre, categoriaNombre, precio_venta, ingredientes) =>
        (
            await api.post(`/api/recetas/${E}`, {
                nombre,
                categoria: categoriaNombre,
                precio_venta,
                ingredientes,
            })
        ).json.data;
    await receta("Latte E2E", "Bebidas", 55, [
        { producto_id: cafe.id, cantidad: 18 },
        { producto_id: leche.id, cantidad: 200 },
    ]);
    await receta("Sándwich E2E", "Alimentos", 90, [{ producto_id: pan.id, cantidad: 2 }]);
    // Un platillo SIN precio: genera un «Pendiente» real en Inicio (la prueba de Pendientes lo necesita, no se omite por falta de datos).
    await receta("Platillo sin precio E2E", "Alimentos", 0, [{ producto_id: pan.id, cantidad: 1 }]);
    log("✔ categorías, proveedor, 3 insumos y 3 recetas (una sin precio, a propósito)");

    // --- POS: mesas y áreas (Barra con pantalla de cocina) ---
    for (const [nombre, capacidad] of [
        ["Mesa E2E 1", 4],
        ["Mesa E2E 2", 2],
        ["Mesa E2E 3", 6],
    ])
        await api.post(`/api/pos/${E}/mesas`, { nombre, capacidad });
    const areas = (await api.get(`/api/pos/${E}/areas`)).json.data;
    for (const a of areas)
        if (!a.pantalla) await api.put(`/api/pos/${E}/areas/${a.id}`, { pantalla: true });
    log(`✔ 3 mesas y ${areas.length} áreas con pantalla de cocina`);

    // --- Operativo (rol «Operativo completo», sin permisos de Admin) ---
    await api.post(`/api/usuarios/${E}`, {
        nombre: "Operativo E2E",
        codigo_ingreso: "E2E-OPERATIVO",
        email: EMAILS.operativo,
        password: passOperativo,
        role_id: 1,
    });
    log("✔ Operativo");

    // --- Segunda empresa compartida: el maestro da acceso al Admin; el Admin cambia a ella y siembra un dato propio de esa empresa ---
    const altaB = (
        await plataforma.post("/api/platform/empresas", {
            empresa: { nombre: EMPRESA_COMPARTIDA.nombre },
            owner: {
                nombre: "Dueña E2E",
                email: EMAILS.duena,
                codigo_ingreso: "E2E-DUENA",
                password: randomBytes(12).toString("hex"),
            },
        })
    ).json.data;
    const EB = altaB.empresa.id;
    await plataforma.put(`/api/platform/usuarios/${alta.owner.id}/empresas/${EB}`, {
        is_admin: true,
    });
    const enB = crearCliente(apiUrl, await jwtDeEmpresa(api, apiUrl, EB));
    await enB.post(`/api/categorias/${EB}`, { nombre: "Insumos compartidos", tipo: "PRODUCTO" });
    const proveedorB = (
        await enB.post(`/api/proveedores/${EB}`, { nombre: "Proveedor compartido E2E" })
    ).json.data;
    await enB.post(`/api/productos/${EB}`, {
        producto: EMPRESA_COMPARTIDA.producto,
        unidad_medida: "g",
        proveedor_id: proveedorB.id,
        categoria: "Insumos compartidos",
        cantidad_presentacion: 1000,
        costo_presentacion: 100,
        stock_actual: 1000,
        stock_minimo: 10,
    });
    log(
        `✔ empresa «${EMPRESA_COMPARTIDA.nombre}» (id ${EB}) con acceso compartido para el Admin y un producto propio`,
    );
    return { empresa_id: E, emails: { admin: EMAILS.admin, operativo: EMAILS.operativo } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    sembrar()
        .then((r) =>
            console.log(
                `Siembra E2E lista · empresa ${r.empresa_id} · ${r.emails.admin} · ${r.emails.operativo}`,
            ),
        )
        .catch((e) => {
            console.error(`\nSiembra E2E falló: ${e.message}`);
            process.exit(1);
        });
}

/**
 * Catálogo de rutas del backend, sacado del router REAL de Express (no de una lista escrita a mano) y clasificado.
 *
 * Es la base de las pruebas de aislamiento multiempresa: cada ruta debe caer en una categoría con un motivo, y una ruta nueva sin
 * clasificar (o un router montado en app.js que esta lista no conoce) hace fallar CI. Nada se ignora en silencio.
 *
 * `inspeccionar` es pura respecto de la base de datos: recibe la app y los routers y devuelve rutas + problemas, así que también se
 * prueba con apps de mentira (test/catalogo-rutas.test.js).
 */

const NOMBRES_PARAM_EMPRESA = "empresa_id";

// Middlewares globales conocidos de app.js (sin ruta propia). Cualquier otro con nombre, o un segundo anónimo, se reporta.
const GLOBALES_PERMITIDOS = new Set([
    "helmetMiddleware",
    "corsMiddleware",
    "jsonParser",
    "requestLogger",
    "errorHandler",
]);
// Los únicos middlewares con ruta propia permitidos: la cadena de autenticación delante de /api.
const CON_RUTA_PERMITIDOS = new Set(["requireAuth", "requireActiveUser", "requirePasswordCurrent"]);

/**
 * Categorías de las rutas que NO llevan `:empresa_id`. `exige` son middlewares que deben figurar en la propia ruta (o `param:<nombre>`
 * para un guard de router.param). Las rutas con `/:empresa_id/` bajo el router de la API se clasifican solas como «tenant».
 */
export const CATEGORIAS = {
    tenant: "Datos de una empresa: el :empresa_id de la URL debe ser el del token (router.param empresa_id → empresaGuard).",
    "previa-sesion":
        "Aún no hay sesión: la identidad la dan credenciales, un código de un solo uso o la cookie de un equipo registrado.",
    "solo-sesion":
        "Opera sobre el usuario del propio token; no recibe ningún identificador de empresa ni de otro usuario.",
    agente: "Agente de impresión: autentica con su token propio (gh_agt_…), que fija su empresa; fuera de la sesión de usuario.",
    plataforma:
        "Cross-tenant POR DISEÑO: solo el usuario maestro de plataforma (requirePlatformAdmin).",
    "empresa-propia": "La ruta lleva :id de empresa y empresaSelfGuard exige que sea la del token.",
    "receta-propia":
        "La ruta lleva :receta_id y recetaEmpresaGuard exige que la receta sea de la empresa del token.",
    salud: "Liveness/readiness públicos: no devuelven datos de ninguna empresa.",
};

const R = (categoria, motivo, exige = []) => ({ categoria, motivo, exige });

/** `METODO /ruta-completa` → categoría. Son las excepciones explícitas; toda ruta nueva fuera de aquí y sin /:empresa_id falla. */
export const EXCEPCIONES = {
    "GET /health": R("salud", "Liveness: responde {status, uptime, ts}."),
    "GET /health/ready": R("salud", "Readiness: SELECT 1; no expone datos."),

    "POST /api/auth/setup": R(
        "previa-sesion",
        "Alta del primer administrador: exige el SETUP_TOKEN del servidor y solo con la base vacía.",
    ),
    "GET /api/auth/invitacion/:token": R(
        "previa-sesion",
        "El token de invitación (un solo uso, con hash en BD) identifica a quien se invita.",
    ),
    "POST /api/auth/invitacion": R(
        "previa-sesion",
        "Acepta una invitación con su token de un solo uso.",
    ),
    "POST /api/auth/login": R(
        "previa-sesion",
        "Correo y contraseña; la empresa sale del usuario autenticado.",
    ),
    "POST /api/auth/dispositivo/registrar": R(
        "previa-sesion",
        "Código de un solo uso de un Admin; deja la cookie del equipo.",
        ["exigirCabeceraCsrf"],
    ),
    "GET /api/auth/dispositivo/personal": R(
        "previa-sesion",
        "La cookie del equipo registrado determina la empresa; lista nombres con PIN.",
    ),
    "POST /api/auth/pin": R(
        "previa-sesion",
        "Cookie del equipo + PIN del usuario de ESA empresa.",
        ["exigirCabeceraCsrf"],
    ),
    "POST /api/auth/logout": R("previa-sesion", "Borra la cookie propia; no lee datos."),

    "POST /api/auth/logout-all": R(
        "solo-sesion",
        "Revoca las sesiones del propio usuario (token_version).",
        ["requireAuth", "requireActiveUser"],
    ),
    "GET /api/auth/me": R("solo-sesion", "Perfil del propio usuario.", [
        "requireAuth",
        "requireActiveUser",
    ]),
    "PUT /api/auth/password": R("solo-sesion", "Cambia la contraseña del propio usuario.", [
        "requireAuth",
        "requireActiveUser",
    ]),

    "POST /api/agente/emparejar": R(
        "agente",
        "Código de emparejamiento de un solo uso (hash en BD) que entrega el token del agente.",
    ),
    "GET /api/agente/version": R(
        "agente",
        "Manifiesto de versión: exige el token del agente (router.use(requireAgente) delante).",
        ["use:requireAgente"],
    ),
    "GET /api/agente/impresiones/pendientes": R(
        "agente",
        "El token gh_agt_ fija la empresa del agente (router.use(requireAgente)).",
        ["use:requireAgente"],
    ),
    "POST /api/agente/impresiones/:id/resultado": R(
        "agente",
        "El token gh_agt_ fija la empresa; la impresión debe ser de esa empresa.",
        ["use:requireAgente"],
    ),

    "GET /api/platform/empresas": R(
        "plataforma",
        "Lista de empresas: solo el maestro de plataforma.",
        ["requirePlatformAdmin"],
    ),
    "POST /api/platform/empresas": R("plataforma", "Alta de empresa + Owner.", [
        "requirePlatformAdmin",
    ]),
    "PATCH /api/platform/empresas/:id/estado": R("plataforma", "Activa/desactiva una empresa.", [
        "requirePlatformAdmin",
    ]),
    "POST /api/platform/empresas/:id/reenviar-invitacion": R(
        "plataforma",
        "Reenvía la invitación del Owner.",
        ["requirePlatformAdmin"],
    ),
    "POST /api/platform/empresas/:id/resetear-password": R(
        "plataforma",
        "Restablece la contraseña del Owner.",
        ["requirePlatformAdmin"],
    ),

    "GET /api/empresas/:id/configuracion": R(
        "empresa-propia",
        "Configuración de la empresa del token.",
        ["empresaSelfGuard"],
    ),
    "PUT /api/empresas/:id/configuracion": R(
        "empresa-propia",
        "Cambia la configuración (solo Admin) de la empresa del token.",
        ["empresaSelfGuard", "requireOwnerOrAdmin"],
    ),

    "GET /api/recetas/:receta_id/detalle": R(
        "receta-propia",
        "Detalle de una receta: la receta debe ser de la empresa del token.",
        ["param:receta_id"],
    ),
};

/** `/api/x/` → `/api/x` (pero la raíz queda `/`). */
const sinBarraFinal = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const unir = (prefijo, ruta) => sinBarraFinal(`${prefijo}${ruta === "/" ? "" : ruta}`) || "/";

export const clave = (metodo, ruta) => `${metodo.toUpperCase()} ${ruta}`;

/** Clasifica una ruta del catálogo. Devuelve `{categoria, motivo, exige}` o `null` si NO está clasificada. */
export function clasificar(r) {
    const exc = EXCEPCIONES[clave(r.metodo, r.ruta)];
    if (exc) return exc;
    // Tenant: bajo el router de la API, con `/:empresa_id` como primer segmento tras el módulo (/api/<modulo>/:empresa_id/...).
    if (
        r.router === "api" &&
        new RegExp(`^/api/[a-z0-9-]+/:${NOMBRES_PARAM_EMPRESA}(/|$)`).test(r.ruta)
    ) {
        return R("tenant", CATEGORIAS.tenant, [`param:${NOMBRES_PARAM_EMPRESA}`]);
    }
    return null;
}

const nombreFn = (fn) => fn?.name || "<anonymous>";

/** ¿El `matcher` de la capa responde al prefijo dado (y solo a él, no a otro)? */
function montadoEn(capa, prefijo) {
    const m = capa.matchers?.[0];
    if (!m) return false;
    const r = m(`${prefijo}/__sonda__`);
    return Boolean(r) && r.path === prefijo && !m("/__otra_ruta__");
}

/**
 * Recorre la app y los routers conocidos.
 * @param {{app: any, montajes: Array<{nombre: string, prefijo: string, router: any, precedidoPor?: string[], capasUso?: Array<{nombre: string, fn: Function}>}>}} p
 * @returns {{rutas: Array, problemas: string[], guardasParam: Record<string, Record<string, string[]>>}}
 */
export function inspeccionar({ app, montajes }) {
    const problemas = [];
    const rutas = [];
    const guardasParam = {};
    const capas = app.router.stack;
    const vistos = new Set();
    let anonimosGlobales = 0;

    capas.forEach((capa, i) => {
        if (capa.route) {
            // Ruta definida directamente en la app (/health): prefijo vacío.
            for (const metodo of Object.keys(capa.route.methods)) {
                if (metodo === "_all")
                    problemas.push(`app.all(${capa.route.path}) no se puede clasificar por método`);
                else
                    rutas.push({
                        metodo: metodo.toUpperCase(),
                        ruta: unir("", capa.route.path),
                        router: "app",
                        mw: capa.route.stack.map((s) => nombreFn(s.handle)),
                    });
            }
            return;
        }
        if (capa.handle?.stack) {
            const montaje = montajes.find((m) => m.router === capa.handle);
            if (!montaje) {
                problemas.push(
                    `Un router montado en app.js no está en el catálogo (capa #${i}): clasifícalo en test/helpers/catalogoRutas.js`,
                );
                return;
            }
            vistos.add(montaje.nombre);
            if (!montadoEn(capa, montaje.prefijo))
                problemas.push(
                    `El router «${montaje.nombre}» no está montado en ${montaje.prefijo} como declara el catálogo`,
                );
            if (montaje.precedidoPor) {
                const previas = capas.slice(Math.max(0, i - montaje.precedidoPor.length), i);
                const nombres = previas.map((c) => nombreFn(c.handle));
                if (
                    nombres.join(",") !== montaje.precedidoPor.join(",") ||
                    !previas.every((c) => montadoEn(c, montaje.prefijo))
                ) {
                    problemas.push(
                        `El router «${montaje.nombre}» debe ir detrás de ${montaje.precedidoPor.join(" → ")} en ${montaje.prefijo}; hay: ${nombres.join(" → ") || "nada"}`,
                    );
                }
            }
            guardasParam[montaje.nombre] = Object.fromEntries(
                Object.entries(capa.handle.params ?? {}).map(([k, fns]) => [k, fns.map(nombreFn)]),
            );
            // router.use(fn) conocidos (por identidad de la función): protegen las rutas que se registran DESPUÉS de ellos.
            const activas = [];
            for (const sub of capa.handle.stack) {
                if (!sub.route) {
                    const uso = (montaje.capasUso ?? []).find((u) => u.fn === sub.handle);
                    if (uso && !sub.handle.stack) activas.push(`use:${uso.nombre}`);
                    else
                        problemas.push(
                            `El router «${montaje.nombre}» tiene una capa que no es ruta (${nombreFn(sub.handle)}): un router.use o router anidado debe declararse en capasUso del catálogo`,
                        );
                    continue;
                }
                if (typeof sub.route.path !== "string") {
                    problemas.push(
                        `El router «${montaje.nombre}» tiene una ruta con path no textual (${String(sub.route.path)})`,
                    );
                    continue;
                }
                for (const metodo of Object.keys(sub.route.methods)) {
                    if (metodo === "_all")
                        problemas.push(
                            `router.all(${sub.route.path}) en «${montaje.nombre}» no se puede clasificar por método`,
                        );
                    else
                        rutas.push({
                            metodo: metodo.toUpperCase(),
                            ruta: unir(montaje.prefijo, sub.route.path),
                            router: montaje.nombre,
                            mw: [...activas, ...sub.route.stack.map((s) => nombreFn(s.handle))],
                        });
                }
            }
            return;
        }
        // Middleware común.
        const nombre = nombreFn(capa.handle);
        if (capa.slash) {
            if (nombre === "<anonymous>") {
                if (++anonimosGlobales > 1)
                    problemas.push(
                        `Hay más de un middleware global anónimo (capa #${i}): dale nombre o añádelo a la lista permitida`,
                    );
            } else if (!GLOBALES_PERMITIDOS.has(nombre))
                problemas.push(`Middleware global desconocido «${nombre}» (capa #${i})`);
        } else if (!CON_RUTA_PERMITIDOS.has(nombre)) {
            problemas.push(
                `Middleware con ruta propia desconocido «${nombre}» (capa #${i}): podría servir endpoints fuera del catálogo`,
            );
        }
    });

    for (const m of montajes)
        if (!vistos.has(m.nombre))
            problemas.push(`El router «${m.nombre}» del catálogo no está montado en app.js`);

    return { rutas, problemas, guardasParam };
}

/** Valida que cada ruta esté clasificada y que lo que su categoría exige esté realmente puesto. Devuelve los problemas. */
export function validarClasificacion({ rutas, guardasParam }) {
    const problemas = [];
    const claves = new Set();
    for (const r of rutas) {
        const k = clave(r.metodo, r.ruta);
        if (claves.has(k)) problemas.push(`Ruta duplicada: ${k}`);
        claves.add(k);
        const c = clasificar(r);
        if (!c) {
            problemas.push(
                `SIN CLASIFICAR: ${k} (router «${r.router}»). Si lleva datos de una empresa, usa /:empresa_id; si es una excepción legítima, agrégala a EXCEPCIONES con su motivo.`,
            );
            continue;
        }
        for (const e of c.exige) {
            if (e.startsWith("param:")) {
                const nombre = e.slice(6);
                const guardas = guardasParam[r.router]?.[nombre] ?? [];
                const esperada =
                    nombre === NOMBRES_PARAM_EMPRESA ? "empresaGuard" : "recetaEmpresaGuard";
                if (!guardas.includes(esperada))
                    problemas.push(
                        `${k}: el router «${r.router}» no tiene ${esperada} en router.param("${nombre}")`,
                    );
            } else if (!r.mw.includes(e))
                problemas.push(
                    `${k}: debería llevar el middleware ${e} (lleva: ${r.mw.join(", ")})`,
                );
        }
    }
    // Excepciones que ya no corresponden a ninguna ruta: lista que se pudre.
    for (const k of Object.keys(EXCEPCIONES))
        if (!claves.has(k))
            problemas.push(
                `La excepción «${k}» ya no corresponde a ninguna ruta: elimínala de EXCEPCIONES`,
            );
    return problemas;
}

/** Cuenta rutas por categoría (para informes). */
export function resumen(rutas) {
    const out = {};
    for (const r of rutas) {
        const c = clasificar(r)?.categoria ?? "SIN CLASIFICAR";
        out[c] = (out[c] ?? 0) + 1;
    }
    return out;
}

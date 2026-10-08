import { inspeccionar } from "./catalogoRutas.js";

/**
 * Importa la app REAL (src/app.js) y sus tres routers y devuelve el catálogo inspeccionado. Hay que haber fijado DATABASE_URL y
 * JWT_SECRET antes de llamarlo (la app crea su pool al importarse).
 */
export async function catalogoReal() {
    const { default: app } = await import("../../src/app.js");
    const { default: routes } = await import("../../src/routes/index.js");
    const { default: authRoutes } = await import("../../src/routes/auth.routes.js");
    const { default: agenteRoutes } = await import("../../src/routes/agente.routes.js");
    const { posController } = await import("../../src/container.js");
    const catalogo = inspeccionar({
        app,
        montajes: [
            {
                nombre: "api",
                prefijo: "/api",
                router: routes,
                precedidoPor: ["requireAuth", "requireActiveUser", "requirePasswordCurrent"],
            },
            { nombre: "auth", prefijo: "/api/auth", router: authRoutes },
            // Todo lo que se registra después de router.use(requireAgente) exige el token del agente; /emparejar va antes, a propósito.
            {
                nombre: "agente",
                prefijo: "/api/agente",
                router: agenteRoutes,
                capasUso: [{ nombre: "requireAgente", fn: posController.requireAgente }],
            },
        ],
    });
    return { app, catalogo };
}

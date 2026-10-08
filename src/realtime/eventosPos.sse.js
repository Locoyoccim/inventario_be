// Endpoint SSE de los avisos del POS (GET /api/pos/:empresa_id/eventos). Autenticación por la cookie de sesión.
import { escuchaLista, suscribir } from "./eventosPos.js";
import ApiError from "../utils/ApiError.js";

const LATIDO_MS = 20_000;
const MAX_POR_USUARIO = 6; // pestañas/equipos del mismo usuario; sobrepasarlo cierra la conexión más vieja
const MAX_TIMEOUT = 2 ** 31 - 1;
const abiertas = new Map(); // usuario_id -> Set<() => void> (cada uno cierra su conexión)

export async function eventosSSE(req, res, next) {
    const empresa_id = Number(req.params.empresa_id);
    const usuario_id = req.user.id;
    if (!Number.isInteger(empresa_id)) return next(ApiError.badRequest("Empresa no válida"));

    // La escucha de la base debe estar activa antes de decir «conectado»: así no se pierden avisos entre una cosa y la otra.
    await escuchaLista();
    if (res.destroyed || req.destroyed) return;
    res.status(200).set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // proxies tipo nginx: que no acumulen la respuesta
    });
    res.flushHeaders();
    res.write("retry: 3000\n\n");

    const mias = abiertas.get(usuario_id) ?? new Set();
    abiertas.set(usuario_id, mias);
    // Muchas conexiones del mismo usuario (pestañas olvidadas): se cierran las más viejas, no la nueva.
    while (mias.size >= MAX_POR_USUARIO) {
        const [masVieja] = mias;
        masVieja();
        mias.delete(masVieja);
    }

    let cerrada = false;
    const enviar = (evento) => {
        if (cerrada) return;
        res.write(`data: ${JSON.stringify(evento)}\n\n`);
        if (evento.tipo === "cierre") cerrar();
    };
    const desuscribir = suscribir(empresa_id, enviar);
    const latido = setInterval(() => !cerrada && res.write(": ping\n\n"), LATIDO_MS);
    // La sesión vence: se cierra el flujo y el navegador vuelve a conectar (ya sin sesión válida recibe 401).
    const vence = req.user.exp ? setTimeout(cerrar, Math.min(MAX_TIMEOUT, Math.max(0, req.user.exp * 1000 - Date.now()))) : null;

    function cerrar() {
        if (cerrada) return;
        cerrada = true;
        clearInterval(latido);
        if (vence) clearTimeout(vence);
        desuscribir();
        mias.delete(cerrar);
        if (mias.size === 0) abiertas.delete(usuario_id);
        res.end();
    }
    mias.add(cerrar);
    req.on("close", cerrar);
    enviar({ tipo: "conectado" });
}

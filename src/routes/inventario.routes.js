import { inventarioController } from "../container.js";

export default function registerInventario(router) {
    router.get("/inventario/:empresa_id", inventarioController.listar);
    router.get("/inventario/:empresa_id/:id", inventarioController.listarPorId);
}

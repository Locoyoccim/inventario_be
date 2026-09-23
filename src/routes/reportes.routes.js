import { reporteController } from "../container.js";

export default function registerReportes(router) {
    router.get("/reportes/:empresa_id/estado", reporteController.estado);
    router.get("/reportes/:empresa_id/inventario", reporteController.inventario);
    router.get("/reportes/:empresa_id/alertas", reporteController.alertas);
    router.get("/reportes/:empresa_id/actividad", reporteController.actividad);
    router.get("/reportes/:empresa_id/consumo", reporteController.consumo);
}

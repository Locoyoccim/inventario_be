import { movimientoController } from "../container.js";

export default function registerMovimientos(router) {
    // Kardex de la empresa (lectura, ambos roles): ?producto_id=&tipo=&desde=&hasta=&sentido=&limit=&offset=
    // Los movimientos por producto y el ajuste manual siguen en productos.routes.js.
    router.get("/movimientos/:empresa_id", movimientoController.listarEmpresa);
}

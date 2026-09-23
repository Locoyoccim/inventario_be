import { Router } from "express";
import { empresaGuard } from "../middlewares/auth.js";
import { recetaEmpresaGuard } from "../middlewares/scopeGuards.js";

import registerUsuarios from "./usuarios.routes.js";
import registerEmpresas from "./empresas.routes.js";
import registerProductos from "./productos.routes.js";
import registerInventario from "./inventario.routes.js";
import registerProveedores from "./proveedores.routes.js";
import registerRecetas from "./recetas.routes.js";
import registerPosMap from "./posmap.routes.js";
import registerVentas from "./ventas.routes.js";
import registerProduccion from "./produccion.routes.js";
import registerConteos from "./conteos.routes.js";
import registerCompras from "./compras.routes.js";
import registerReportes from "./reportes.routes.js";
import registerCategorias from "./categorias.routes.js";
import registerMovimientos from "./movimientos.routes.js";

const router = Router();

// Guards por parámetro de ruta (aplican a todas las rutas registradas en este router).
router.param("empresa_id", empresaGuard);
router.param("receta_id", recetaEmpresaGuard);

// Cada módulo registra sus rutas en el router compartido.
[
    registerUsuarios,
    registerEmpresas,
    registerProductos,
    registerInventario,
    registerProveedores,
    registerRecetas,
    registerPosMap,
    registerVentas,
    registerProduccion,
    registerConteos,
    registerCompras,
    registerReportes,
    registerCategorias,
    registerMovimientos,
].forEach((register) => register(router));

export default router;

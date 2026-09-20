import { Router } from "express";
import UsuarioRepository from "../modules/usuarios/usuario.repository.js";
import UsuarioService from "../modules/usuarios/usuario.service.js";
import UsuarioController from "../modules/usuarios/usuarios.controller.js";
import EmpresaRepository from "../modules/empresas/empresa.repository.js";
import EmpresaService from "../modules/empresas/empresa.service.js";
import EmpresaController from "../modules/empresas/empresa.controller.js";
import ProductosController from "../modules/productos/productos.controller.js";
import ProductosService from "../modules/productos/productos.service.js";
import ProductosRepository from "../modules/productos/productos.repository.js";
import ProveedorController from "../modules/proveedores/proveedor.controller.js";
import ProveedorService from "../modules/proveedores/proveedor.service.js";
import ProveedorRepository from "../modules/proveedores/proveedor.repository.js";
import RecetaController from "../modules/recetas/receta.controller.js";
import RecetaService from "../modules/recetas/receta.service.js";
import RecetaRepository from "../modules/recetas/receta.repository.js";
import RecetaDetalleController from "../modules/recetaDetalle/recetaDetalle.controller.js";
import RecetaDetalleService from "../modules/recetaDetalle/recetaDetalle.service.js";
import RecetaDetalleRepository from "../modules/recetaDetalle/recetaDetalle.repository.js";
import InventarioController from "../modules/inventario/inventario.controller.js";
import InventarioService from "../modules/inventario/inventario.service.js";
import InventarioRepository from "../modules/inventario/inventario.repository.js";
import MovimientoController from "../modules/movimientos/movimiento.controller.js";
import MovimientoService from "../modules/movimientos/movimiento.service.js";
import MovimientoRepository from "../modules/movimientos/movimiento.repository.js";
import PosMapController from "../modules/posMap/posMap.controller.js";
import PosMapService from "../modules/posMap/posMap.service.js";
import PosMapRepository from "../modules/posMap/posMap.repository.js";
import VentaController from "../modules/ventas/venta.controller.js";
import VentaService from "../modules/ventas/venta.service.js";
import VentaRepository from "../modules/ventas/venta.repository.js";

const router = Router();

// Inyección de dependencias (DIP)
// Empresas
const empresaRepo = new EmpresaRepository();
const empresaService = new EmpresaService(empresaRepo);
const empresaController = new EmpresaController(empresaService);

// Inyección de dependencias (DIP)
// Usuarios - Corregido para pasar la instancia de empresaRepo
const usuarioRepo = new UsuarioRepository();
const usuarioService = new UsuarioService(usuarioRepo, empresaRepo);
const usuarioController = new UsuarioController(usuarioService);

// Inyección de dependencias (DIP)
// Productos
const productoRepo = new ProductosRepository();
const productoService = new ProductosService(productoRepo);
const productoController = new ProductosController(productoService);

// Inyección dependencias (DIP)
//proveedores
const proveedorRepo = new ProveedorRepository();
const proveedorService = new ProveedorService(proveedorRepo, empresaRepo);
const proveedorController = new ProveedorController(proveedorService);

// Inyección dependencias (DIP)
//recetas
const recetaRepo = new RecetaRepository();
const recetaService = new RecetaService(recetaRepo, empresaRepo);
const recetaController = new RecetaController(recetaService);

// Inyección dependencias (DIP)
//recetas detalle
const recetaDetalleRepo = new RecetaDetalleRepository();
const recetaDetalleService = new RecetaDetalleService(recetaDetalleRepo, recetaRepo);
const recetaDetalleController = new RecetaDetalleController(recetaDetalleService);

// Inyección dependencias (DIP)
//inventario
const inventarioRepo = new InventarioRepository();
const inventarioService = new InventarioService(inventarioRepo, empresaRepo);
const inventarioController = new InventarioController(inventarioService);

// Inyección dependencias (DIP)
//movimientos de inventario
const movimientoRepo = new MovimientoRepository();
const movimientoService = new MovimientoService(movimientoRepo);
const movimientoController = new MovimientoController(movimientoService);

// Inyección dependencias (DIP)
//pos_map (mapeo nombres del POS -> recetas/insumos)
const posMapRepo = new PosMapRepository();
const posMapService = new PosMapService(posMapRepo, empresaRepo);
const posMapController = new PosMapController(posMapService);

// Inyección dependencias (DIP)
//ventas (importación diaria; reutiliza movimientoRepo para descontar stock)
const ventaRepo = new VentaRepository(movimientoRepo);
const ventaService = new VentaService(ventaRepo, empresaRepo);
const ventaController = new VentaController(ventaService);

// EndPoints Usuarios
router.get("/usuarios/:empresa_id", usuarioController.listar);
router.get("/usuarios/:empresa_id/:id", usuarioController.listarPorId);
router.delete("/usuarios/:empresa_id/:id", usuarioController.eliminar);
router.post("/usuarios/:empresa_id", usuarioController.crear);
router.put("/usuarios/:empresa_id/:id", usuarioController.actualizar);

// EndPoints Empresas
router.get("/empresas/", empresaController.listar);
router.get("/empresas/:id", empresaController.listarPorId);
router.post("/empresas/", empresaController.crearEmpresa);
router.put("/empresas/:id", empresaController.actualizarEmpresa);
router.delete("/empresas/:id", empresaController.eliminarEmpresa);

// EndPoints Productos
router.get("/productos/:empresa_id", productoController.listar);
router.get("/productos/:empresa_id/:id", productoController.listarPorId);
router.post("/productos/:empresa_id/", productoController.crearProducto);
router.put("/productos/:empresa_id/:id", productoController.actualizarProducto);
router.delete("/productos/:empresa_id/:id", productoController.eliminarProducto);

// EndPoints Movimientos de Inventario
router.get("/productos/:empresa_id/:id/movimientos", movimientoController.listar);
router.post("/productos/:empresa_id/:id/movimientos", movimientoController.crear);

// EndPoints Inventario (solo lectura: el stock se gestiona desde /productos)
router.get("/inventario/:empresa_id", inventarioController.listar);
router.get("/inventario/:empresa_id/:id", inventarioController.listarPorId);

// EndPoints Proveedores
router.get("/proveedores/:empresa_id", proveedorController.listar);
router.get("/proveedores/:empresa_id/:id", proveedorController.listarPorId);
router.post("/proveedores/:empresa_id", proveedorController.crear);
router.put("/proveedores/:empresa_id/:id", proveedorController.actualizar);
router.delete("/proveedores/:empresa_id/:id", proveedorController.eliminar);

// EndPoints Recetas Detalle
router.get("/recetas/:receta_id/detalle", recetaDetalleController.listar);
router.get("/recetas/:receta_id/detalle/:id", recetaDetalleController.listarPorId);
router.post("/recetas/:receta_id/detalle", recetaDetalleController.crear);
router.put("/recetas/:receta_id/detalle/:id", recetaDetalleController.actualizar);
router.delete("/recetas/:receta_id/detalle/:id", recetaDetalleController.eliminar);

// EndPoints Recetas
router.post("/recetas/:empresa_id/preview", recetaController.preview);
router.get("/recetas/:empresa_id", recetaController.listar);
router.get("/recetas/:empresa_id/:id", recetaController.listarPorId);
router.post("/recetas/:empresa_id", recetaController.crear);
router.put("/recetas/:empresa_id/:id", recetaController.actualizar);
router.delete("/recetas/:empresa_id/:id", recetaController.eliminar);

// EndPoints PosMap (mapeo de nombres del reporte de Toteat)
router.get("/pos-map/:empresa_id", posMapController.listar);
router.get("/pos-map/:empresa_id/:id", posMapController.listarPorId);
router.post("/pos-map/:empresa_id/bulk", posMapController.crearBulk);
router.post("/pos-map/:empresa_id", posMapController.crear);
router.put("/pos-map/:empresa_id/:id", posMapController.actualizar);
router.delete("/pos-map/:empresa_id/:id", posMapController.eliminar);

// EndPoints Ventas (importación diaria del mix de Toteat)
router.post("/ventas/:empresa_id/importar", ventaController.importar);
router.get("/ventas/:empresa_id/:fecha", ventaController.consultarDia);
router.delete("/ventas/:empresa_id/:fecha", ventaController.revertirDia);

export default router;

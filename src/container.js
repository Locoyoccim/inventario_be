// Contenedor de inyección de dependencias (DIP).
// Centraliza el "cableado" de repos/services/controllers; las rutas consumen los
// controllers desde aquí. Antes esto vivía dentro de routes/index.js (archivo-Dios).
import UsuarioRepository from "./modules/usuarios/usuario.repository.js";
import UsuarioService from "./modules/usuarios/usuario.service.js";
import UsuarioController from "./modules/usuarios/usuarios.controller.js";
import EmpresaRepository from "./modules/empresas/empresa.repository.js";
import EmpresaService from "./modules/empresas/empresa.service.js";
import EmpresaController from "./modules/empresas/empresa.controller.js";
import ProductosController from "./modules/productos/productos.controller.js";
import ProductosService from "./modules/productos/productos.service.js";
import ProductosRepository from "./modules/productos/productos.repository.js";
import ProveedorController from "./modules/proveedores/proveedor.controller.js";
import ProveedorService from "./modules/proveedores/proveedor.service.js";
import ProveedorRepository from "./modules/proveedores/proveedor.repository.js";
import RecetaController from "./modules/recetas/receta.controller.js";
import RecetaService from "./modules/recetas/receta.service.js";
import RecetaRepository from "./modules/recetas/receta.repository.js";
import RecetaDetalleController from "./modules/recetaDetalle/recetaDetalle.controller.js";
import RecetaDetalleService from "./modules/recetaDetalle/recetaDetalle.service.js";
import RecetaDetalleRepository from "./modules/recetaDetalle/recetaDetalle.repository.js";
import InventarioController from "./modules/inventario/inventario.controller.js";
import InventarioService from "./modules/inventario/inventario.service.js";
import InventarioRepository from "./modules/inventario/inventario.repository.js";
import MovimientoController from "./modules/movimientos/movimiento.controller.js";
import MovimientoService from "./modules/movimientos/movimiento.service.js";
import MovimientoRepository from "./modules/movimientos/movimiento.repository.js";
import PosMapController from "./modules/posMap/posMap.controller.js";
import PosMapService from "./modules/posMap/posMap.service.js";
import PosMapRepository from "./modules/posMap/posMap.repository.js";
import VentaController from "./modules/ventas/venta.controller.js";
import VentaService from "./modules/ventas/venta.service.js";
import VentaRepository from "./modules/ventas/venta.repository.js";
import ProduccionController from "./modules/produccion/produccion.controller.js";
import ProduccionService from "./modules/produccion/produccion.service.js";
import ProduccionRepository from "./modules/produccion/produccion.repository.js";
import ConteoController from "./modules/conteos/conteo.controller.js";
import ConteoService from "./modules/conteos/conteo.service.js";
import ConteoRepository from "./modules/conteos/conteo.repository.js";
import CompraController from "./modules/compras/compra.controller.js";
import CompraService from "./modules/compras/compra.service.js";
import CompraRepository from "./modules/compras/compra.repository.js";
import ReporteController from "./modules/reportes/reporte.controller.js";
import ReporteService from "./modules/reportes/reporte.service.js";
import ReporteRepository from "./modules/reportes/reporte.repository.js";
import FinanzasController from "./modules/finanzas/finanzas.controller.js";
import FinanzasService from "./modules/finanzas/finanzas.service.js";
import FinanzasRepository from "./modules/finanzas/finanzas.repository.js";
import CategoriaController from "./modules/categorias/categoria.controller.js";
import CategoriaService from "./modules/categorias/categoria.service.js";
import CategoriaRepository from "./modules/categorias/categoria.repository.js";

// Repos base compartidos
const empresaRepo = new EmpresaRepository();
const movimientoRepo = new MovimientoRepository();
const recetaRepo = new RecetaRepository();

// Controllers (lo que consumen las rutas)
export const empresaController = new EmpresaController(new EmpresaService(empresaRepo));
export const usuarioController = new UsuarioController(new UsuarioService(new UsuarioRepository(), empresaRepo));
export const productoController = new ProductosController(new ProductosService(new ProductosRepository()));
export const proveedorController = new ProveedorController(new ProveedorService(new ProveedorRepository(), empresaRepo));
export const recetaController = new RecetaController(new RecetaService(recetaRepo, empresaRepo));
export const recetaDetalleController = new RecetaDetalleController(new RecetaDetalleService(new RecetaDetalleRepository(), recetaRepo));
export const inventarioController = new InventarioController(new InventarioService(new InventarioRepository(), empresaRepo));
export const movimientoController = new MovimientoController(new MovimientoService(movimientoRepo));
export const posMapController = new PosMapController(new PosMapService(new PosMapRepository(), empresaRepo));
export const ventaController = new VentaController(new VentaService(new VentaRepository(movimientoRepo), empresaRepo));
export const produccionController = new ProduccionController(new ProduccionService(new ProduccionRepository(movimientoRepo), empresaRepo));
export const conteoController = new ConteoController(new ConteoService(new ConteoRepository(movimientoRepo), empresaRepo));
export const compraController = new CompraController(new CompraService(new CompraRepository(movimientoRepo), empresaRepo));
export const reporteController = new ReporteController(new ReporteService(new ReporteRepository(), empresaRepo));
export const categoriaController = new CategoriaController(new CategoriaService(new CategoriaRepository(), empresaRepo));
export const finanzasController = new FinanzasController(new FinanzasService(new FinanzasRepository()));

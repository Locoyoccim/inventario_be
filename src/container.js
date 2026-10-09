// Contenedor de inyección de dependencias (DIP).
// Centraliza el "cableado" de repos/services/controllers; las rutas consumen los
// controllers desde aquí. Antes esto vivía dentro de routes/index.js (archivo-Dios).
import UsuarioRepository from "./modules/usuarios/usuario.repository.js";
import UsuarioService from "./modules/usuarios/usuario.service.js";
import UsuarioController from "./modules/usuarios/usuarios.controller.js";
import DispositivoRepository from "./modules/dispositivos/dispositivo.repository.js";
import PinService from "./modules/auth/pin.service.js";
import PinController from "./modules/auth/pin.controller.js";
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
import MovimientoController from "./modules/movimientos/movimiento.controller.js";
import MovimientoService from "./modules/movimientos/movimiento.service.js";
import MovimientoRepository from "./modules/movimientos/movimiento.repository.js";
import ProduccionController from "./modules/produccion/produccion.controller.js";
import ProduccionService from "./modules/produccion/produccion.service.js";
import ProduccionRepository from "./modules/produccion/produccion.repository.js";
import ConteoController from "./modules/conteos/conteo.controller.js";
import ConteoService from "./modules/conteos/conteo.service.js";
import ConteoRepository from "./modules/conteos/conteo.repository.js";
import CompraController from "./modules/compras/compra.controller.js";
import CompraService from "./modules/compras/compra.service.js";
import CompraRepository from "./modules/compras/compra.repository.js";
import AnalisisController from "./modules/analisis/analisis.controller.js";
import AnalisisService from "./modules/analisis/analisis.service.js";
import AnalisisRepository from "./modules/analisis/analisis.repository.js";
import ReporteController from "./modules/reportes/reporte.controller.js";
import ReporteService from "./modules/reportes/reporte.service.js";
import ReporteRepository from "./modules/reportes/reporte.repository.js";
import FinanzasController from "./modules/finanzas/finanzas.controller.js";
import FinanzasService from "./modules/finanzas/finanzas.service.js";
import FinanzasRepository from "./modules/finanzas/finanzas.repository.js";
import CategoriaController from "./modules/categorias/categoria.controller.js";
import CategoriaService from "./modules/categorias/categoria.service.js";
import CategoriaRepository from "./modules/categorias/categoria.repository.js";
import PlatformController from "./modules/platform/platform.controller.js";
import PlatformService from "./modules/platform/platform.service.js";
import PlatformRepository from "./modules/platform/platform.repository.js";
import RolController from "./modules/roles/rol.controller.js";
import RolService from "./modules/roles/rol.service.js";
import RolRepository from "./modules/roles/rol.repository.js";
import ReservacionController from "./modules/reservaciones/reservaciones.controller.js";
import ReservacionService from "./modules/reservaciones/reservaciones.service.js";
import ReservacionRepository from "./modules/reservaciones/reservaciones.repository.js";
import PosConfigController from "./modules/pos/posConfig.controller.js";
import PosConfigService from "./modules/pos/posConfig.service.js";
import PosConfigRepository from "./modules/pos/posConfig.repository.js";
import PosComandasRepository from "./modules/pos/pos.comandas.repository.js";
import PosOpcionesController from "./modules/pos/pos.opciones.controller.js";
import PosOpcionesRepository from "./modules/pos/pos.opciones.repository.js";
import PosController from "./modules/pos/pos.controller.js";
import PosCuentasRepository from "./modules/pos/pos.cuentas.repository.js";
import PosImpresionRepository from "./modules/pos/pos.impresion.repository.js";
import PosTurnosRepository from "./modules/pos/pos.turnos.repository.js";
import PosAjustesRepository from "./modules/pos/pos.ajustes.repository.js";

// Repos base compartidos
const empresaRepo = new EmpresaRepository();
const movimientoRepo = new MovimientoRepository();
const recetaRepo = new RecetaRepository();

// Controllers (lo que consumen las rutas)
export const empresaController = new EmpresaController(new EmpresaService(empresaRepo));
const usuarioRepo = new UsuarioRepository();
export const usuarioController = new UsuarioController(
    new UsuarioService(usuarioRepo, empresaRepo),
);
const dispositivoRepo = new DispositivoRepository();
export const pinController = new PinController(
    new PinService(dispositivoRepo, usuarioRepo),
    dispositivoRepo,
);
export const productoController = new ProductosController(
    new ProductosService(new ProductosRepository()),
);
export const proveedorController = new ProveedorController(
    new ProveedorService(new ProveedorRepository(), empresaRepo),
);
export const recetaController = new RecetaController(new RecetaService(recetaRepo, empresaRepo));
export const movimientoController = new MovimientoController(new MovimientoService(movimientoRepo));
export const produccionController = new ProduccionController(
    new ProduccionService(new ProduccionRepository(movimientoRepo), empresaRepo),
);
export const conteoController = new ConteoController(
    new ConteoService(new ConteoRepository(movimientoRepo), empresaRepo),
);
export const compraController = new CompraController(
    new CompraService(new CompraRepository(movimientoRepo), empresaRepo),
);
export const reporteController = new ReporteController(
    new ReporteService(new ReporteRepository(), empresaRepo),
);
export const analisisController = new AnalisisController(
    new AnalisisService(new AnalisisRepository()),
);
export const categoriaController = new CategoriaController(
    new CategoriaService(new CategoriaRepository(), empresaRepo),
);
export const finanzasController = new FinanzasController(
    new FinanzasService(new FinanzasRepository()),
);
export const platformController = new PlatformController(
    new PlatformService(new PlatformRepository()),
);
export const rolController = new RolController(new RolService(new RolRepository()));
export const reservacionController = new ReservacionController(
    new ReservacionService(new ReservacionRepository()),
);
const posConfigRepo = new PosConfigRepository();
export const posConfigController = new PosConfigController(new PosConfigService(posConfigRepo));
export const posOpcionesRepo = new PosOpcionesRepository();
export const posOpcionesController = new PosOpcionesController(posOpcionesRepo);
const posCuentasRepo = new PosCuentasRepository(posConfigRepo, movimientoRepo, posOpcionesRepo);
export const posController = new PosController(
    posCuentasRepo,
    new PosImpresionRepository(),
    new PosTurnosRepository(),
    new PosAjustesRepository(posCuentasRepo, movimientoRepo),
    new PosComandasRepository(),
);

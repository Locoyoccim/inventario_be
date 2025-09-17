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
const productoRepo = new ProductosRepository();
const productoService = new ProductosService(productoRepo);
const productoController = new ProductosController(productoService);

// EndPoints Usuarios
router.get("/usuarios/", usuarioController.listar);
router.get("/usuarios/:id", usuarioController.listarPorId);
router.delete("/usuarios/:id", usuarioController.eliminar);
router.post("/usuarios/", usuarioController.crear);
router.put("/usuarios/:id", usuarioController.actualizar);

// EndPoints Empresas
router.get("/empresas/", empresaController.listar);
router.get("/empresas/:id", empresaController.listarPorId);
router.post("/empresas/", empresaController.crearEmpresa);
router.put("/empresas/:id", empresaController.actualizarEmpresa);
router.delete("/empresas/:id", empresaController.eliminarEmpresa);

// EndPoints Productos
router.get("/productos/", productoController.listar);
router.get("/productos/:id", productoController.listarPorId);
router.post("/productos/", productoController.crearProducto);
router.put("/productos/:id", productoController.actualizarProducto);
router.delete("/productos/:id", productoController.eliminarProducto);
 
export default router;

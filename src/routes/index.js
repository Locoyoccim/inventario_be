import { Router } from "express";
import UsuarioRepository from "../modules/usuarios/usuario.repository.js";
import UsuarioService from "../modules/usuarios/usuario.service.js";
import UsuarioController from "../modules/usuarios/usuarios.controller.js";
import EmpresaRepository from "../modules/empresas/empresa.repository.js";
import EmpresaService from "../modules/empresas/empresa.service.js";
import EmpresaController from "../modules/empresas/empresa.controller.js";

const router = Router();

// Inyección de dependencias (DIP)
// Usuarios
const usuarioRepo = new UsuarioRepository();
const usuarioService = new UsuarioService(usuarioRepo);
const usuarioController = new UsuarioController(usuarioService);

// Empresas
const empresaRepo = new EmpresaRepository();
const empresaService = new EmpresaService(empresaRepo);
const empresaController = new EmpresaController(empresaService);

// EndPoints
router.get("/usuarios/", usuarioController.listar);
router.get("/usuarios/:id", usuarioController.listarPorId);
router.get("/empresas/", empresaController.listar);
router.get("/empresas/:id", empresaController.listarPorId);

export default router;

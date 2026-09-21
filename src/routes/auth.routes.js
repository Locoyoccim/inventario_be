import { Router } from "express";
import UsuarioRepository from "../modules/usuarios/usuario.repository.js";
import AuthService from "../modules/auth/auth.service.js";
import AuthController from "../modules/auth/auth.controller.js";
import { validate } from "../middlewares/validate.js";
import { loginSchema, setupSchema } from "../modules/auth/auth.schema.js";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();
const usuarioRepo = new UsuarioRepository();
const authService = new AuthService(usuarioRepo);
const authController = new AuthController(authService);

router.post("/setup", validate(setupSchema), authController.setup);
router.post("/login", validate(loginSchema), authController.login);
router.get("/me", requireAuth, authController.me);

export default router;

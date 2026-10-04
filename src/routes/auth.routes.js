import { Router } from "express";
import UsuarioRepository from "../modules/usuarios/usuario.repository.js";
import AuthService from "../modules/auth/auth.service.js";
import AuthController from "../modules/auth/auth.controller.js";
import { validate } from "../middlewares/validate.js";
import { loginSchema, setupSchema, changePasswordSchema, aceptarInvitacionSchema } from "../modules/auth/auth.schema.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireActiveUser } from "../middlewares/activeUser.js";

const router = Router();
const usuarioRepo = new UsuarioRepository();
const authService = new AuthService(usuarioRepo);
const authController = new AuthController(authService);

router.post("/setup", validate(setupSchema), authController.setup);
router.get("/invitacion/:token", authController.verInvitacion);
router.post("/invitacion", validate(aceptarInvitacionSchema), authController.aceptarInvitacion);
router.post("/login", validate(loginSchema), authController.login);
router.post("/logout", authController.logout);
router.post("/logout-all", requireAuth, requireActiveUser, authController.logoutAll);
router.get("/me", requireAuth, requireActiveUser, authController.me);
// Fuera del bloqueo de must_change_password (no pasa por requirePasswordCurrent): así el
// usuario con contraseña temporal puede resolverlo.
router.put("/password", requireAuth, requireActiveUser, validate(changePasswordSchema), authController.changePassword);

export default router;

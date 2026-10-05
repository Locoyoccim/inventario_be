import { Router } from "express";
import UsuarioRepository from "../modules/usuarios/usuario.repository.js";
import AuthService from "../modules/auth/auth.service.js";
import AuthController from "../modules/auth/auth.controller.js";
import { validate } from "../middlewares/validate.js";
import { loginSchema, setupSchema, changePasswordSchema, aceptarInvitacionSchema } from "../modules/auth/auth.schema.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireActiveUser } from "../middlewares/activeUser.js";
import { pinController } from "../container.js";
import { exigirCabeceraCsrf } from "../modules/auth/pin.controller.js";
import { entrarConPinSchema, registrarDispositivoSchema } from "../modules/auth/pin.schema.js";

const router = Router();
const usuarioRepo = new UsuarioRepository();
const authService = new AuthService(usuarioRepo);
const authController = new AuthController(authService);

router.post("/setup", validate(setupSchema), authController.setup);
router.get("/invitacion/:token", authController.verInvitacion);
router.post("/invitacion", validate(aceptarInvitacionSchema), authController.aceptarInvitacion);
router.post("/login", validate(loginSchema), authController.login);
// Ingreso con PIN: público, pero solo desde un equipo que un Admin registró (cookie httpOnly del equipo).
router.post("/dispositivo/registrar", exigirCabeceraCsrf, validate(registrarDispositivoSchema), pinController.registrarEquipo);
router.get("/dispositivo/personal", pinController.personal);
router.post("/pin", exigirCabeceraCsrf, validate(entrarConPinSchema), pinController.entrar);
router.post("/logout", authController.logout);
router.post("/logout-all", requireAuth, requireActiveUser, authController.logoutAll);
router.get("/me", requireAuth, requireActiveUser, authController.me);
// Fuera del bloqueo de must_change_password (no pasa por requirePasswordCurrent): así el
// usuario con contraseña temporal puede resolverlo.
router.put("/password", requireAuth, requireActiveUser, validate(changePasswordSchema), authController.changePassword);

export default router;

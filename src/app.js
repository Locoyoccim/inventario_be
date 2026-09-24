import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import routes from "./routes/index.js";
import authRoutes from "./routes/auth.routes.js";
import { requireAuth } from "./middlewares/auth.js";
import { requireActiveUser } from "./middlewares/activeUser.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import pool from "./config/db.js";

const app = express();

// Detrás de proxy (Railway) para que req.ip sea la IP real del cliente (rate limit correcto).
app.set("trust proxy", 1);

// Cabeceras de seguridad
app.use(helmet());

// CORS con credenciales (la sesión viaja en cookie httpOnly). Con credenciales no se
// permite "*": se usa la lista CORS_ORIGINS. Sin lista: en desarrollo refleja cualquier
// origen; en producción solo acepta peticiones del mismo origen.
const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !corsOrigins?.length) {
    console.warn("[cors] CORS_ORIGINS vacío en producción: solo se aceptan peticiones del mismo origen.");
}
app.use(cors({ origin: corsOrigins?.length ? corsOrigins : !isProduction, credentials: true }));

// Límite de tamaño del body (evita payloads abusivos)
app.use(express.json({ limit: "100kb" }));
app.use((req, _res, next) => { if (req.body === undefined || req.body === null) req.body = {}; next(); });
app.use(requestLogger);

// Healthcheck público (sin auth ni rate limit) — liveness para monitoreo/deploy
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime(), ts: new Date().toISOString() }));

// Readiness: verifica la BD (SELECT 1). 503 si no responde. Separado de /health (liveness)
// para que un parpadeo de la base no provoque reinicios del contenedor.
app.get("/health/ready", async (_req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({ status: "ready", ts: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: "unavailable" });
    }
});

// Rate limiting. Login/setup estrictos (anti fuerza bruta); resto de la API con tope amplio.
const limiter = (max, error) =>
    rateLimit({ windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { success: false, error } });
const authLimiter = limiter(10, "Demasiados intentos de acceso. Espera un minuto.");
const apiLimiter = limiter(300, "Demasiadas solicitudes. Intenta de nuevo en un momento.");

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/setup", authLimiter);
app.use("/api", apiLimiter);

// Rutas de autenticación (login abierto)
app.use("/api/auth", authRoutes);

// Resto de la API: requiere token válido
app.use("/api", requireAuth, requireActiveUser, routes);

// Middleware central de errores (siempre al final)
app.use(errorHandler);

export default app;

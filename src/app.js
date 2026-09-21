import express from "express";
import cors from "cors";
import routes from "./routes/index.js";
import authRoutes from "./routes/auth.routes.js";
import { requireAuth } from "./middlewares/auth.js";
import { requestLogger } from "./middlewares/requestLogger.js";
import { errorHandler } from "./middlewares/errorHandler.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => { if (req.body === undefined || req.body === null) req.body = {}; next(); });
app.use(requestLogger);

// Rutas de autenticación (login abierto)
app.use("/api/auth", authRoutes);

// Resto de la API: requiere token válido
app.use("/api", requireAuth, routes);

// Middleware central de errores (siempre al final)
app.use(errorHandler);

export default app;

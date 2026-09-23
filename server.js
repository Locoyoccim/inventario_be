// Cargar .env ANTES que cualquier otro módulo: varios leen process.env al importarse
// (app.js: CORS_ORIGINS/NODE_ENV). Los imports ESM se evalúan en orden.
import "dotenv/config";
import app from "./src/app.js";

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
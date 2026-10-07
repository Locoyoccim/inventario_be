// Importar este módulo ejecuta la validación de la configuración. server.js lo importa ANTES que app.js y la base: los imports
// ESM se evalúan en orden, y así una configuración insegura aborta antes de crear la app o abrir una sola conexión.
import { validateEnv } from "./env.js";

validateEnv();

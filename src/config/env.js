import { z } from "zod";

// Valida la configuración crítica ANTES de levantar el servidor y aborta si algo falta.
// No corre en pruebas (NODE_ENV=test) para no exigir secretos en la suite.
const schema = z
    .object({
        NODE_ENV: z.string().optional(),
        JWT_SECRET: z.string().min(32, "JWT_SECRET debe tener al menos 32 caracteres"),
        DATABASE_URL: z.string().optional(),
        DB_USER: z.string().optional(),
        DB_HOST: z.string().optional(),
        DB_NAME: z.string().optional(),
        DB_PASSWORD: z.string().optional(),
        DB_PORT: z.string().optional(),
        CORS_ORIGINS: z.string().optional(),
        SETUP_TOKEN: z.string().optional(),
        PIN_PEPPER: z.string().optional(),
    })
    .superRefine((env, ctx) => {
        const tieneUrl = !!env.DATABASE_URL;
        const tieneVars = env.DB_USER && env.DB_HOST && env.DB_NAME && env.DB_PASSWORD && env.DB_PORT;
        if (!tieneUrl && !tieneVars) {
            ctx.addIssue({
                code: "custom",
                message: "Falta DATABASE_URL o el conjunto DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT",
            });
        }
        if (esProductivo(env)) {
            if (!env.CORS_ORIGINS)
                ctx.addIssue({ code: "custom", message: "CORS_ORIGINS es obligatorio en producción" });
            if (!env.SETUP_TOKEN)
                ctx.addIssue({ code: "custom", message: "SETUP_TOKEN es obligatorio en producción" });
        }
    });

// Cualquier entorno que no sea explícitamente "development" o "test" se trata como
// productivo (staging, demo, o NODE_ENV ausente/mal configurado), para no permitir
// silenciosamente un CORS abierto a cualquier origen con credenciales.
function esProductivo(env) {
    return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}

// --- Calidad de los secretos en producción ---------------------------------------------------------------------------------

/** Cómo generar un secreto bueno (se muestra en los mensajes de error). */
export const COMANDO_GENERAR = `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`;

/**
 * Valores que ya viven en el repositorio (ejemplos, README, CI y pruebas). Si alguno llegara a producción, el secreto sería
 * público. Se comparan sin distinguir mayúsculas ni espacios en los extremos.
 */
export const SECRETOS_CONOCIDOS = [
    "cambia-esto-por-un-secreto-largo-y-aleatorio",
    "un_secreto_de_al_menos_32_caracteres_aqui",
    "ci-secret-no-usar-en-produccion",
    "secreto-de-prueba",
    "test_secret_de_al_menos_32_caracteres_ok",
];

// Un valor que contiene estas palabras es un texto de ejemplo aunque no esté en la lista exacta (basta cambiar un carácter).
const PALABRAS_DE_EJEMPLO = ["cambia", "changeme", "ejemplo", "example", "placeholder", "genera", "no-usar", "secreto", "secret", "password"];

const VARIEDAD_MINIMA = 10; // caracteres distintos; un secreto aleatorio de 32+ caracteres tiene bastantes más

/** Problemas de un secreto (sin incluir NUNCA su valor en el mensaje). `comprobarLargo`: false si otra regla ya lo valida. */
function problemasDeSecreto(nombre, valor, minimo, comprobarLargo = true) {
    const out = [];
    if (comprobarLargo && valor.length < minimo) out.push(`${nombre} debe tener al menos ${minimo} caracteres`);
    const normal = valor.trim().toLowerCase();
    if (SECRETOS_CONOCIDOS.includes(normal) || /^<.*>$/.test(normal) || PALABRAS_DE_EJEMPLO.some((p) => normal.includes(p))) {
        out.push(`${nombre} parece un valor de ejemplo o de prueba (no se permite en producción)`);
    } else if (new Set(valor).size < VARIEDAD_MINIMA) {
        out.push(`${nombre} es demasiado repetitivo (menos de ${VARIEDAD_MINIMA} caracteres distintos)`);
    }
    if (out.length) out.push(`  → genera uno nuevo con: ${COMANDO_GENERAR}`);
    return out;
}

/** Reglas de secretos para producción. Función pura: no lee process.env ni imprime. */
export function problemasDeSecretos(env) {
    if (!esProductivo(env)) return [];
    const out = [];
    // La longitud de JWT_SECRET ya la valida el esquema (en todos los entornos).
    if (env.JWT_SECRET) out.push(...problemasDeSecreto("JWT_SECRET", env.JWT_SECRET, 32, false));
    if (env.SETUP_TOKEN) out.push(...problemasDeSecreto("SETUP_TOKEN", env.SETUP_TOKEN, 24));
    // La pimienta del PIN va aparte: si fuera JWT_SECRET, rotar el secreto de sesión dejaría inservibles todos los PIN.
    if (!env.PIN_PEPPER) out.push("PIN_PEPPER es obligatorio en producción (pimienta del hash de los PIN; distinta de JWT_SECRET)");
    else out.push(...problemasDeSecreto("PIN_PEPPER", env.PIN_PEPPER, 32));
    const secretos = { JWT_SECRET: env.JWT_SECRET, PIN_PEPPER: env.PIN_PEPPER, SETUP_TOKEN: env.SETUP_TOKEN };
    const nombres = Object.keys(secretos);
    for (let i = 0; i < nombres.length; i++) {
        for (let j = i + 1; j < nombres.length; j++) {
            const a = secretos[nombres[i]];
            if (a && a === secretos[nombres[j]]) out.push(`${nombres[i]} y ${nombres[j]} deben ser distintos`);
        }
    }
    return out;
}

/** Lista de problemas de configuración (vacía si todo está bien). Pura y probable sin arrancar el servidor. */
export function evaluarEnv(env) {
    const r = schema.safeParse(env);
    const delEsquema = r.success ? [] : r.error.issues.map((i) => i.message);
    return [...delEsquema, ...problemasDeSecretos(env)];
}

export function validateEnv() {
    if (process.env.NODE_ENV === "test") return;
    const problemas = evaluarEnv(process.env);
    if (problemas.length) {
        console.error("Configuración inválida (.env):");
        for (const p of problemas) console.error(p.startsWith("  ") ? p : ` - ${p}`);
        process.exit(1);
    }
}

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
    })
    .superRefine((env, ctx) => {
        const tieneUrl = !!env.DATABASE_URL;
        const tieneVars = env.DB_USER && env.DB_HOST && env.DB_NAME && env.DB_PASSWORD && env.DB_PORT;
        if (!tieneUrl && !tieneVars) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Falta DATABASE_URL o el conjunto DB_USER/DB_HOST/DB_NAME/DB_PASSWORD/DB_PORT",
            });
        }
        if (env.NODE_ENV === "production") {
            if (!env.CORS_ORIGINS)
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CORS_ORIGINS es obligatorio en producción" });
            if (!env.SETUP_TOKEN)
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SETUP_TOKEN es obligatorio en producción" });
        }
    });

export function validateEnv() {
    if (process.env.NODE_ENV === "test") return;
    const r = schema.safeParse(process.env);
    if (!r.success) {
        console.error("Configuración inválida (.env):");
        for (const i of r.error.issues) console.error(" -", i.message);
        process.exit(1);
    }
}

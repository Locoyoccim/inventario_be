// Valida req.body contra un esquema zod. Si falla, pasa el ZodError al errorHandler (400).
// Si pasa, reemplaza req.body por los datos ya parseados/normalizados.
export const validate = (schema) => (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(result.error);
    req.body = result.data;
    next();
};
export default validate;

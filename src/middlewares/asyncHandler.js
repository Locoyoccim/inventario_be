// Envuelve un handler async para que cualquier throw/rechazo llegue al middleware de errores.
export const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
export default asyncHandler;

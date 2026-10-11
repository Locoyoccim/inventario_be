import jwt from "jsonwebtoken";

// Se leen en cada llamada (no al importar el módulo): así no dependen del orden en que
// se cargue .env respecto a los imports.
function secret() {
    const value = process.env.JWT_SECRET;
    if (!value) throw new Error("JWT_SECRET no está configurado en el entorno");
    return value;
}

// Algoritmo fijo: se firma y se verifica solo con HS256. Sin fijarlo en la verificación, la librería acepta cualquier variante HMAC
// (HS384, HS512) con la misma clave; hoy no es explotable, pero así un cambio futuro de librería o de clave no abre otra puerta.
const ALGORITMO = "HS256";

// `expiresIn` opcional: la sesión de PIN dura un turno, no los 7 días de la de correo y contraseña.
// Si el payload ya trae `exp` (re-firmar una sesión viva, p. ej. al cambiar de empresa) se conserva tal cual: no se extiende la caducidad.
export function signToken(payload, expiresIn = process.env.JWT_EXPIRES || "7d") {
    if (payload.exp) return jwt.sign(payload, secret(), { algorithm: ALGORITMO });
    return jwt.sign(payload, secret(), { algorithm: ALGORITMO, expiresIn });
}

export function verifyToken(token) {
    return jwt.verify(token, secret(), { algorithms: [ALGORITMO] });
}

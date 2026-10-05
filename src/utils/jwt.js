import jwt from "jsonwebtoken";

// Se leen en cada llamada (no al importar el módulo): así no dependen del orden en que
// se cargue .env respecto a los imports.
function secret() {
    const value = process.env.JWT_SECRET;
    if (!value) throw new Error("JWT_SECRET no está configurado en el entorno");
    return value;
}

// `expiresIn` opcional: la sesión de PIN dura un turno, no los 7 días de la de correo y contraseña.
export function signToken(payload, expiresIn = process.env.JWT_EXPIRES || "7d") {
    return jwt.sign(payload, secret(), { expiresIn });
}

export function verifyToken(token) {
    return jwt.verify(token, secret());
}

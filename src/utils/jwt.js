import jwt from "jsonwebtoken";

// Se leen en cada llamada (no al importar el módulo): así no dependen del orden en que
// se cargue .env respecto a los imports.
function secret() {
    const value = process.env.JWT_SECRET;
    if (!value) throw new Error("JWT_SECRET no está configurado en el entorno");
    return value;
}

export function signToken(payload) {
    return jwt.sign(payload, secret(), { expiresIn: process.env.JWT_EXPIRES || "7d" });
}

export function verifyToken(token) {
    return jwt.verify(token, secret());
}

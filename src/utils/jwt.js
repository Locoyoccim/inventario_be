import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES || "7d";

export function signToken(payload) {
    if (!SECRET) throw new Error("JWT_SECRET no está configurado en el entorno");
    return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

export function verifyToken(token) {
    if (!SECRET) throw new Error("JWT_SECRET no está configurado en el entorno");
    return jwt.verify(token, SECRET);
}

// Lógica pura del ingreso con PIN en equipos registrados (sin base de datos: se prueba aparte).
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";

export const PIN_REGEX = /^\d{4,6}$/;
export const VIGENCIA_CODIGO_MIN = 15;
export const TOKEN_DISPOSITIVO_PREFIJO = "gh_dev_";

// Enfriamiento: al llegar a `max` fallos dentro de la ventana, no se acepta otro intento hasta `enfriaSeg` después del último.
export const LIMITES = {
    usuarioDispositivo: { max: 5, enfriaSeg: 300 },
    dispositivo: { max: 15, enfriaSeg: 300 },
    ip: { max: 30, enfriaSeg: 300 },
    // Bloqueo duro: fallos acumulados de un usuario (en cualquier equipo) en la ventana; solo un Admin lo quita.
    duro: { max: 10, ventanaMin: 60 },
    ventanaMin: 15,
};

/** Un PIN de 4 a 6 dígitos que no sea trivial (mismo dígito repetido o escalera ascendente/descendente). */
export function validarPin(pin) {
    if (typeof pin !== "string" || !PIN_REGEX.test(pin)) return "El PIN debe tener de 4 a 6 dígitos";
    const d = [...pin].map(Number);
    if (d.every((x) => x === d[0])) return "El PIN no puede repetir el mismo dígito";
    const paso = d[1] - d[0];
    if (Math.abs(paso) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === paso)) return "El PIN no puede ser una secuencia (1234, 4321...)";
    return null;
}

const pimienta = () => process.env.PIN_PEPPER || process.env.JWT_SECRET || "";
// El PIN se mezcla con el id del usuario y una pimienta del servidor antes de bcrypt: dos usuarios con el mismo PIN no comparten
// hash y quien solo lea la base no puede probar los 10^4 PINs posibles sin el secreto del servidor.
const semilla = (usuario_id, pin) => createHmac("sha256", pimienta()).update(`${usuario_id}:${pin}`).digest("hex");

export const hashPin = (usuario_id, pin) => bcrypt.hash(semilla(usuario_id, pin), 10);

// Hash dummy (costo 10, como los reales) para que el tiempo no cambie cuando no hay PIN que comparar.
const HASH_DUMMY = "$2b$10$c/FzyZ996ndTpNk0UdNRnelYmxARV.QBfT.9gCgJs/1gjT1Vj6ZW2";
export const verificarPin = (usuario_id, pin, hash) => bcrypt.compare(semilla(usuario_id, pin), hash ?? HASH_DUMMY);

/** Segundos que faltan para poder reintentar (0 = libre). `grupo` = { n, ultimoMs }; `ahoraMs` en la misma base de tiempo. */
export function esperaSeg(grupo, limite, ahoraMs) {
    if (!grupo || grupo.n < limite.max || grupo.ultimoMs == null) return 0;
    return Math.max(0, Math.ceil((grupo.ultimoMs + limite.enfriaSeg * 1000 - ahoraMs) / 1000));
}

/** El mayor tiempo de espera entre los tres enfriamientos (usuario+equipo, equipo, IP). */
export function esperaTotalSeg({ usuarioDispositivo, dispositivo, ip }, ahoraMs) {
    return Math.max(
        esperaSeg(usuarioDispositivo, LIMITES.usuarioDispositivo, ahoraMs),
        esperaSeg(dispositivo, LIMITES.dispositivo, ahoraMs),
        esperaSeg(ip, LIMITES.ip, ahoraMs),
    );
}

export const superaBloqueoDuro = (fallosEnVentana) => fallosEnVentana >= LIMITES.duro.max;

// ---- Equipos: código de un solo uso y token ----
// Sin 0/O/1/I para que se pueda dictar o leer en una hoja sin confundirse.
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generarCodigo() {
    let c = "";
    for (let i = 0; i < 8; i++) c += ALFABETO[randomInt(ALFABETO.length)];
    return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export const normalizarCodigo = (codigo) => String(codigo ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashCodigo = (codigo) => createHash("sha256").update(normalizarCodigo(codigo)).digest("hex");
export const generarTokenDispositivo = () => `${TOKEN_DISPOSITIVO_PREFIJO}${randomBytes(24).toString("hex")}`;
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

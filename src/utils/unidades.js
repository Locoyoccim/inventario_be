// Catálogo canónico de unidades de medida y normalización de variantes.
// El sistema NO convierte entre unidades: la cantidad de una receta se asume en la
// MISMA unidad que el `unidad_medida` del producto. Esto solo normaliza la etiqueta.
import { normalizar } from "./normalize.js";

// Unidades canónicas admitidas (cómo se guardan).
export const UNIDADES_CANONICAS = ["g", "kg", "ml", "l", "pieza", "porcion"];

// Variante (normalizada: minúsculas, sin acentos, sin espacios de más) -> canónica.
const VARIANTES = {
    g: "g", gr: "g", grs: "g", grms: "g", gramo: "g", gramos: "g",
    kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogramo: "kg", kilogramos: "kg",
    ml: "ml", mls: "ml", mililitro: "ml", mililitros: "ml", cc: "ml", "c.c.": "ml",
    l: "l", lt: "l", lts: "l", litro: "l", litros: "l",
    pieza: "pieza", piezas: "pieza", pza: "pieza", pzas: "pieza", pz: "pieza", pzs: "pieza",
    unidad: "pieza", unidades: "pieza", u: "pieza", und: "pieza", uds: "pieza", "c/u": "pieza", cu: "pieza",
    porcion: "porcion", porciones: "porcion", racion: "porcion", raciones: "porcion",
};

// Devuelve la unidad canónica, o null si no se reconoce.
export function canonizarUnidad(input) {
    const clave = normalizar(input);
    if (!clave) return null;
    if (VARIANTES[clave]) return VARIANTES[clave];
    if (UNIDADES_CANONICAS.includes(clave)) return clave;
    return null;
}

export default canonizarUnidad;

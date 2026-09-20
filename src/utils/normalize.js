// Normaliza un texto para comparar nombres del POS con el mapeo:
// minúsculas, sin acentos/diacríticos, sin espacios de más.
export function normalizar(texto) {
    return String(texto ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // quita acentos
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

export default normalizar;

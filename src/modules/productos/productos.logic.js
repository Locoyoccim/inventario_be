// Normaliza los parámetros de filtro del listado de productos (query -> opciones).
export function parseFiltrosProductos(query = {}) {
    const q = (query.q ?? "").toString().trim();
    const categoria = (query.categoria ?? "").toString().trim();
    const esTrue = (v) => v === true || v === "true" || v === "1";
    return {
        q: q || null,
        categoria: categoria || null,
        bajoMinimo: esTrue(query.bajo_minimo),
        incluirInactivos: esTrue(query.incluir_inactivos),
    };
}

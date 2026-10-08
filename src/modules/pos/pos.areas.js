// Áreas de preparación por defecto de una empresa y sugerencia de área para una categoría nueva.

const SEED_AREAS = `
    INSERT INTO areas_preparacion (empresa_id, nombre, imprime, es_default)
    VALUES ($1, 'Cocina', true, true), ($1, 'Barra', true, false), ($1, 'Sin comanda', false, false)
    ON CONFLICT (empresa_id, nombre) DO NOTHING`;

// Empresas nuevas no traen áreas: se siembran la primera vez que hacen falta (solo si no tienen ninguna).
export async function asegurarAreas(db, empresa_id) {
    const r = await db.query("SELECT 1 FROM areas_preparacion WHERE empresa_id = $1 LIMIT 1", [empresa_id]);
    if (r.rowCount === 0) await db.query(SEED_AREAS, [empresa_id]);
}

const sinAcentos = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Palabras que identifican una categoría de bebidas (singular, sin acentos).
const BEBIDAS = new Set([
    "bebida", "cafe", "te", "jugo", "licuado", "smoothie", "refresco", "cerveza", "vino", "coctel", "cocteleria",
    "licor", "mezcal", "tequila", "malteada", "frappe", "soda", "infusion", "barra", "bar", "agua",
]);
const singular = (p) => (p.length > 3 && p.endsWith("es") && BEBIDAS.has(p.slice(0, -2)) ? p.slice(0, -2) : p.length > 2 && p.endsWith("s") ? p.slice(0, -1) : p);

// Nombre del área que conviene a una categoría nueva ("Bebidas" -> "Barra"), o null si no hay sugerencia
// (lo demás va al área por defecto de la empresa, normalmente Cocina). Siempre se puede cambiar después.
export function areaSugerida(nombreCategoria) {
    const palabras = sinAcentos(nombreCategoria).split(/[^a-z0-9]+/).filter(Boolean);
    return palabras.some((p) => BEBIDAS.has(singular(p))) ? "Barra" : null;
}

// Id del área activa que imprime con ese nombre (siembra las áreas si la empresa aún no las tiene).
export async function areaIdPorNombre(db, empresa_id, nombre) {
    await asegurarAreas(db, empresa_id);
    const r = await db.query(
        "SELECT id FROM areas_preparacion WHERE empresa_id = $1 AND lower(nombre) = lower($2) AND activo AND imprime LIMIT 1",
        [empresa_id, nombre],
    );
    return r.rows[0]?.id ?? null;
}

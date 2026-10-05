// Lógica pura de las opciones por producto (sin BD): validar lo que el mesero eligió y calcular precio y consumo.
import ApiError from "../../utils/ApiError.js";

const centavos = (n) => Math.round(Number(n) * 100);

/**
 * Valida la selección contra los grupos que tiene asignados el artículo y devuelve el snapshot de las opciones y su extra.
 * @param grupos  [{ id, nombre, minimo, maximo, modificadores: [{ id, nombre, precio_extra, producto_id, cantidad }] }] (solo activos)
 * @param ids     ids de modificadores elegidos (sin repetir)
 * @returns { opciones: [{ id, grupo, nombre, precio_extra, producto_id, cantidad }], extra }
 */
export function validarSeleccion(grupos, ids = []) {
    const elegidos = [...new Set(ids.map(Number))];
    const porId = new Map();
    for (const g of grupos) for (const m of g.modificadores) porId.set(Number(m.id), { grupo: g, modificador: m });

    const desconocido = elegidos.find((id) => !porId.has(id));
    if (desconocido !== undefined) throw ApiError.badRequest("Una opción ya no está disponible para este producto");

    const opciones = [];
    let extraC = 0;
    for (const g of grupos) {
        const delGrupo = elegidos.filter((id) => porId.get(id).grupo.id === g.id);
        if (delGrupo.length < g.minimo) {
            throw ApiError.badRequest(g.minimo === 1 && g.maximo === 1 ? `Elige una opción de «${g.nombre}»` : `Elige al menos ${g.minimo} de «${g.nombre}»`);
        }
        if (delGrupo.length > g.maximo) {
            throw ApiError.badRequest(g.maximo === 1 ? `«${g.nombre}» admite una sola opción` : `«${g.nombre}» admite hasta ${g.maximo} opciones`);
        }
        for (const id of delGrupo) {
            const m = porId.get(id).modificador;
            opciones.push({
                id: Number(m.id), grupo: g.nombre, nombre: m.nombre, precio_extra: Number(m.precio_extra),
                producto_id: m.producto_id ?? null, cantidad: m.cantidad === null || m.cantidad === undefined ? null : Number(m.cantidad),
            });
            extraC += centavos(m.precio_extra);
        }
    }
    opciones.sort((a, b) => a.id - b.id); // orden estable: dos renglones con las mismas opciones tienen el mismo jsonb
    return { opciones, extra: extraC / 100 };
}

/** Precio de lista de una pieza con sus extras (mismo criterio de IVA que el artículo: el extra se suma al precio capturado). */
export const precioConExtras = (precio, extra) => (centavos(precio) + centavos(extra)) / 100;

/** Insumos que consumen las opciones de los renglones: producto_id -> cantidad total (por pieza vendida). */
export function consumoDeOpciones(items) {
    const consumo = new Map();
    for (const item of items) {
        if (item.estado === "CANCELADO") continue;
        for (const o of item.opciones ?? []) {
            if (!o.producto_id || !(Number(o.cantidad) > 0)) continue;
            consumo.set(Number(o.producto_id), (consumo.get(Number(o.producto_id)) ?? 0) + Number(o.cantidad) * Number(item.cantidad));
        }
    }
    return consumo;
}

/** Texto corto de las opciones para comandas y tickets: ["Medio", "Extra queso"]. */
export const nombresOpciones = (opciones) => (opciones ?? []).map((o) => o.nombre);

import { netoABruto } from "./costeo.js";

// Renglones ya resueltos ({receta_id | producto_id, cantidad}) -> consumo por producto_id.
// Una receta explota UN nivel y su consumo pasa por merma; un producto se descuenta tal cual.
// Renglones extra (nombre_pos, etc.) viajan intactos en recetas_sin_escandallo.
export function explotarRenglones(renglones, recetaDetalle, mermaPorId = new Map()) {
    const porReceta = new Map();
    for (const d of recetaDetalle) {
        if (!porReceta.has(d.receta_id)) porReceta.set(d.receta_id, []);
        porReceta.get(d.receta_id).push(d);
    }

    const netoReceta = new Map();
    const netoInsumo = new Map();
    const recetas_sin_escandallo = [];
    const acum = (map, pid, cant) => map.set(pid, (map.get(pid) ?? 0) + cant);

    for (const r of renglones) {
        const cant = Number(r.cantidad);
        if (r.receta_id != null) {
            const detalles = porReceta.get(Number(r.receta_id)) ?? [];
            if (detalles.length === 0) {
                recetas_sin_escandallo.push(r);
                continue;
            }
            for (const d of detalles) acum(netoReceta, Number(d.producto_id), cant * Number(d.cantidad));
        } else if (r.producto_id != null) {
            acum(netoInsumo, Number(r.producto_id), cant);
        }
    }

    const consumo = new Map();
    const pids = new Set([...netoReceta.keys(), ...netoInsumo.keys()]);
    for (const pid of pids) {
        const bruto = netoReceta.has(pid) ? netoABruto(netoReceta.get(pid), mermaPorId.get(pid)) : 0;
        const directo = netoInsumo.get(pid) ?? 0;
        consumo.set(pid, Number((bruto + directo).toFixed(3)));
    }
    return { consumo, recetas_sin_escandallo };
}

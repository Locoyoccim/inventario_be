// Resolución de preparaciones/subrecetas anidadas (BOM). Lógica pura, sin BD: se usa tanto
// para la auto-producción al importar ventas (venta.repository.js) como para planificar una
// producción manual que depende de subrecetas sin stock suficiente (produccion.repository.js).
import ApiError from "./ApiError.js";
import { netoABruto } from "./costeo.js";

const r3 = (n) => Number(Number(n).toFixed(3));

// Resuelve preparaciones: cuando el consumo de un elaborado supera su stock, calcula
// la auto-producción del faltante desde sus insumos (recursivo, con tope de profundidad
// y detección de ciclos). NO altera el consumo de los elaborados; devuelve el consumo
// propagado a insumos (consumoFinal) y la lista de auto-producciones.
//   consumo:       Map(producto_id -> cantidad)
//   stockActual:   Map(producto_id -> stock)
//   preparaciones: Map(producto_elaborado_id -> { receta_id, rendimiento, nombre, unidad, detalle:[{producto_id, cantidad}] })
export function resolverPreparaciones(consumo, stockActual, preparaciones, mermaPorId = new Map(), maxDepth = 5) {
    const consumoFinal = new Map(consumo);
    const producido = new Map();    // elaboradoId -> total auto-producido
    const insumosAcum = new Map();  // elaboradoId -> Map(insumoId -> cantidad)

    const maxIter = maxDepth + 2; // margen para confirmar convergencia (DAG); un ciclo no converge
    let cambio = true;
    let iter = 0;
    while (cambio && iter < maxIter) {
        cambio = false;
        iter++;
        for (const [elabId, prep] of preparaciones.entries()) {
            const consumoTotal = consumoFinal.get(elabId);
            if (consumoTotal === undefined) continue;
            const disponible = Math.max(Number(stockActual.get(elabId) ?? 0), 0) + (producido.get(elabId) ?? 0);
            const faltante = r3(consumoTotal - disponible);
            if (faltante <= 1e-9) continue;
            const rendimiento = Number(prep.rendimiento) || 1;
            producido.set(elabId, r3((producido.get(elabId) ?? 0) + faltante));
            if (!insumosAcum.has(elabId)) insumosAcum.set(elabId, new Map());
            const acum = insumosAcum.get(elabId);
            for (const d of prep.detalle) {
                const pid = Number(d.producto_id);
                // El consumo del insumo se descuenta en BRUTO (aplica su merma de limpieza).
                const add = netoABruto((faltante * Number(d.cantidad)) / rendimiento, mermaPorId.get(pid));
                consumoFinal.set(pid, r3((consumoFinal.get(pid) ?? 0) + add));
                acum.set(pid, r3((acum.get(pid) ?? 0) + add));
            }
            cambio = true;
        }
    }
    if (cambio) {
        throw ApiError.badRequest(
            "No se pudo resolver la auto-producción: posible ciclo entre preparaciones o anidamiento mayor a 5 niveles"
        );
    }

    const autoProduccion = [];
    for (const [elabId, cantidad] of producido.entries()) {
        const prep = preparaciones.get(elabId);
        const rendimiento = Number(prep.rendimiento) || 1;
        const acum = insumosAcum.get(elabId) ?? new Map();
        autoProduccion.push({
            producto_elaborado_id: elabId,
            receta_id: prep.receta_id,
            nombre: prep.nombre,
            unidad: prep.unidad,
            cantidad,
            lotes_equivalentes: r3(cantidad / rendimiento),
            insumos: [...acum.entries()].map(([producto_id, c]) => ({ producto_id, cantidad: c })),
        });
    }
    return { consumoFinal, autoProduccion };
}

// Construye el Map de preparaciones (producto_elaborado_id -> info + escandallo) a partir de
// las recetas-preparación y el escandallo completo de la empresa.
export function armarPreparaciones(prepRows, detalleRows) {
    const detalleByReceta = new Map();
    for (const d of detalleRows) {
        const k = Number(d.receta_id);
        if (!detalleByReceta.has(k)) detalleByReceta.set(k, []);
        detalleByReceta.get(k).push({ producto_id: Number(d.producto_id), cantidad: Number(d.cantidad) });
    }
    const prep = new Map();
    for (const r of prepRows) {
        prep.set(Number(r.producto_elaborado_id), {
            receta_id: Number(r.receta_id),
            rendimiento: Number(r.rendimiento) || 1,
            nombre: r.nombre,
            unidad: r.unidad,
            detalle: detalleByReceta.get(Number(r.receta_id)) ?? [],
        });
    }
    return prep;
}

// Ordena las auto-producciones para presentación: una subreceta que es insumo de otra debe
// listarse antes (orden de producción). Topológico simple; empate conserva el orden recibido.
export function ordenarPorDependencia(autoProduccion) {
    const porElaborado = new Map(autoProduccion.map((a) => [a.producto_elaborado_id, a]));
    const visitado = new Set();
    const salida = [];
    function visitar(item) {
        if (visitado.has(item.producto_elaborado_id)) return;
        visitado.add(item.producto_elaborado_id);
        for (const insumo of item.insumos) {
            const dep = porElaborado.get(insumo.producto_id);
            if (dep) visitar(dep);
        }
        salida.push(item);
    }
    for (const item of autoProduccion) visitar(item);
    return salida;
}

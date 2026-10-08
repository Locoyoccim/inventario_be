/**
 * Reporter de guardia para CI (se usa junto al reporter `spec`). Hace fallar la corrida si:
 *  - alguna prueba se OMITIÓ (`skip`) o quedó pendiente (`todo`);
 *  - algún archivo `*.test.js` existente en disco no reportó ninguna prueba ejecutada y aprobada
 *    (una suite que «desaparece» no puede dar un verde silencioso).
 * No imprime el resultado normal: solo los motivos del fallo, por stderr.
 */
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const RAIZ_TEST = resolve("test");

function archivosDePrueba(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const ruta = join(dir, e.name);
        if (e.isDirectory()) out.push(...archivosDePrueba(ruta));
        else if (e.name.endsWith(".test.js")) out.push(ruta);
    }
    return out;
}

/** Análisis puro de los eventos (separado para poder probarlo sin ejecutar el runner). */
export function evaluarEventos(eventos, archivosEsperados) {
    const omitidas = [];
    const pasadasPorArchivo = new Map();
    for (const { type, data } of eventos) {
        if (type !== "test:pass" && type !== "test:fail") continue;
        // Una suite omitida (`describe(..., { skip })`) no reporta sus pruebas: se detecta en la propia suite.
        if (data.details?.type === "suite" && !(data.skip !== undefined && data.skip !== false)) continue;
        if (data.skip !== undefined && data.skip !== false) omitidas.push(`${data.file ?? "?"} › ${data.name} (omitida: ${data.skip === true ? "skip" : data.skip})`);
        else if (data.todo !== undefined && data.todo !== false) omitidas.push(`${data.file ?? "?"} › ${data.name} (pendiente: todo)`);
        else if (type === "test:pass" && data.file) pasadasPorArchivo.set(data.file, (pasadasPorArchivo.get(data.file) ?? 0) + 1);
    }
    const sinEjecutar = archivosEsperados.filter((f) => !pasadasPorArchivo.has(f));
    return { omitidas, sinEjecutar };
}

export default async function* guardiaCi(source) {
    const eventos = [];
    for await (const ev of source) {
        if (ev.type === "test:pass" || ev.type === "test:fail") eventos.push({ type: ev.type, data: ev.data });
    }
    const { omitidas, sinEjecutar } = evaluarEventos(eventos, archivosDePrueba(RAIZ_TEST));
    if (omitidas.length || sinEjecutar.length) {
        process.exitCode = 1;
        yield "\n=== GUARDIA DE CI: la corrida NO es válida ===\n";
        for (const o of omitidas) yield `  OMITIDA   ${relative(process.cwd(), o.split(" › ")[0])} › ${o.split(" › ").slice(1).join(" › ")}\n`;
        for (const f of sinEjecutar) yield `  SIN PRUEBAS EJECUTADAS  ${relative(process.cwd(), f)}\n`;
    }
}

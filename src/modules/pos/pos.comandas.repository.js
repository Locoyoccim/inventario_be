// Estado de las comandas en la pantalla de cocina (KDS): qué hay por preparar en cada área y su avance.
// NUEVA -> EN_PREPARACION -> LISTA -> ENTREGADA. Las transiciones son monótonas y se protegen en SQL
// (`UPDATE ... WHERE estado = ANY(permitidos)`): dos tablets tocando a la vez no hacen retroceder el estado.
import pool from "../../config/db.js";
import ApiError from "../../utils/ApiError.js";
import { notificar } from "../../realtime/eventosPos.js";

const MIN_DESHACER = 10; // una comanda marcada «lista» se puede regresar a «preparando» durante este tiempo
const MIN_LISTAS_VISIBLES = 10; // las listas siguen en pantalla un rato para que se recojan
const MIN_CANCELADAS_VISIBLES = 3; // una comanda cancelada se muestra un momento para que la cocina vea que ya no se prepara

// Estados desde los que se puede llegar a cada uno (lo demás es un retroceso o un salto que no existe).
export const DESDE = {
    EN_PREPARACION: ["NUEVA", "LISTA"], // desde LISTA = deshacer, solo dentro de la ventana
    LISTA: ["NUEVA", "EN_PREPARACION"],
    ENTREGADA: ["LISTA"],
};
export const ESTADOS_DESTINO = Object.keys(DESDE);

const COMANDA_COLS = "k.id, k.numero, k.estado, k.created_at, k.en_preparacion_at, k.lista_at, k.entregada_at, k.actualizada_at";

export default class PosComandasRepository {
    // Comandas activas de las áreas con pantalla. `area_id` opcional (null = todas), para una tablet por área o una de expedición.
    async activas(empresa_id, area_id = null) {
        const comandas = (await pool.query(
            `SELECT ${COMANDA_COLS}, k.area_id, a.nombre AS area, a.tiempo_objetivo_min,
                    c.id AS cuenta_id, c.folio, c.tipo, c.nombre_cliente, m.nombre AS mesa, u.nombre AS mesero, now() AS ahora,
                    COALESCE((SELECT MAX(i.tiempo) FROM pos_cuenta_items i WHERE i.comanda_id = k.id), 1) AS tiempo
             FROM pos_comandas k
             JOIN areas_preparacion a ON a.id = k.area_id AND a.pantalla
             JOIN empresas e ON e.id = k.empresa_id AND e.usa_pantalla_cocina
             JOIN pos_cuentas c ON c.id = k.cuenta_id
             LEFT JOIN mesas m ON m.id = c.mesa_id
             LEFT JOIN usuarios u ON u.id = c.mesero_id
             WHERE k.empresa_id = $1 AND ($2::int IS NULL OR k.area_id = $2)
               AND (k.estado IN ('NUEVA','EN_PREPARACION')
                    OR (k.estado = 'LISTA' AND k.lista_at > now() - make_interval(mins => $3))
                    OR (k.estado = 'CANCELADA' AND k.actualizada_at > now() - make_interval(mins => $4)))
             ORDER BY k.created_at, k.id`,
            [empresa_id, area_id, MIN_LISTAS_VISIBLES, MIN_CANCELADAS_VISIBLES],
        )).rows;
        const ids = comandas.map((c) => c.id);
        const renglones = ids.length
            ? (await pool.query(
                  "SELECT id, comanda_id, nombre, cantidad, notas, estado, opciones, comensal FROM pos_cuenta_items WHERE comanda_id = ANY($1::int[]) ORDER BY id",
                  [ids],
              )).rows
            : [];
        const porComanda = new Map();
        for (const r of renglones) {
            if (!porComanda.has(r.comanda_id)) porComanda.set(r.comanda_id, []);
            porComanda.get(r.comanda_id).push({ id: r.id, nombre: r.nombre, cantidad: r.cantidad, notas: r.notas, opciones: (r.opciones ?? []).map((o) => o.nombre), comensal: r.comensal, cancelado: r.estado === "CANCELADO" });
        }
        return comandas.map((c) => ({ ...c, renglones: porComanda.get(c.id) ?? [] }));
    }

    // Mueve una comanda de estado. Repetir el mismo estado (otra tablet ya lo hizo) no es un error.
    async cambiarEstado(empresa_id, id, estado) {
        const origen = DESDE[estado];
        if (!origen) throw ApiError.badRequest(`Estado no válido: ${estado}`);
        const r = await pool.query(
            `UPDATE pos_comandas k SET estado = $3::text,
                    en_preparacion_at = CASE WHEN $3::text = 'EN_PREPARACION' THEN COALESCE(k.en_preparacion_at, now())
                                             WHEN $3::text = 'LISTA' THEN COALESCE(k.en_preparacion_at, now()) ELSE k.en_preparacion_at END,
                    lista_at = CASE WHEN $3::text = 'LISTA' THEN now() WHEN $3::text = 'EN_PREPARACION' THEN NULL ELSE k.lista_at END,
                    entregada_at = CASE WHEN $3::text = 'ENTREGADA' THEN now() ELSE k.entregada_at END,
                    actualizada_at = now()
             WHERE k.id = $1 AND k.empresa_id = $2 AND k.estado = ANY($4::text[])
               AND ($3::text <> 'EN_PREPARACION' OR k.estado <> 'LISTA' OR k.lista_at > now() - make_interval(mins => $5))
             RETURNING ${COMANDA_COLS.replaceAll("k.", "")}`,
            [id, empresa_id, estado, origen, MIN_DESHACER],
        );
        if (r.rows[0]) {
            // Aviso a las pantallas y al mesero de esa cuenta (solo cuando el estado cambió de verdad).
            const cuenta = (await pool.query("SELECT c.id AS cuenta_id, c.mesero_id, k.area_id FROM pos_comandas k JOIN pos_cuentas c ON c.id = k.cuenta_id WHERE k.id = $1", [id])).rows[0];
            await notificar(pool, { tipo: "comanda.estado", empresa_id, comanda_id: id, estado, ...(cuenta ?? {}) });
            return r.rows[0];
        }
        const actual = (await pool.query(`SELECT ${COMANDA_COLS} FROM pos_comandas k WHERE k.id = $1 AND k.empresa_id = $2`, [id, empresa_id])).rows[0];
        if (!actual) throw ApiError.notFound("Comanda no encontrada");
        if (actual.estado === estado) return actual;
        if (estado === "EN_PREPARACION" && actual.estado === "LISTA") throw ApiError.conflict(`Ya pasaron más de ${MIN_DESHACER} minutos: una comanda lista ya no se regresa a preparación`, { estado: actual.estado });
        throw ApiError.conflict(`La comanda ya está ${actual.estado.toLowerCase().replace("_", " ")}`, { estado: actual.estado });
    }
}

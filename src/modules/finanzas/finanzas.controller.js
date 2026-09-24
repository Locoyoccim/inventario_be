import { asyncHandler } from "../../middlewares/asyncHandler.js";
import { parsePagination } from "../../utils/pagination.js";
import { esFechaReal } from "../../utils/fecha.js";
import ApiError from "../../utils/ApiError.js";

const esAdmin = (req) => !!(req.user?.is_admin || req.user?.is_owner);
const boolQuery = (v) => v === "true" || v === "1";
function fechaQuery(v, campo) {
    if (v === undefined || v === null || v === "") return null;
    if (!esFechaReal(String(v))) throw ApiError.badRequest(`${campo} inválida (YYYY-MM-DD)`);
    return String(v);
}

export default class FinanzasController {
    constructor(finanzasService) {
        this.finanzasService = finanzasService;
    }

    // ---- Categorías ----
    listarCategorias = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const data = await this.finanzasService.listarCategorias(empresa_id, boolQuery(req.query.incluir_inactivas));
        res.json({ success: true, data });
    });
    crearCategoria = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const nueva = await this.finanzasService.crearCategoria(empresa_id, req.body.nombre);
        res.status(201).json({ success: true, data: nueva });
    });
    actualizarCategoria = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.finanzasService.actualizarCategoria(empresa_id, id, req.body) });
    });

    // ---- Gastos ----
    listarGastos = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const { limit, offset } = parsePagination(req.query);
        const filtros = {
            desde: fechaQuery(req.query.desde, "desde"),
            hasta: fechaQuery(req.query.hasta, "hasta"),
            categoria_id: req.query.categoria_id ? Number(req.query.categoria_id) : null,
            incluirAnulados: boolQuery(req.query.incluir_anulados),
            limit, offset,
        };
        const solo = esAdmin(req) ? null : req.user.id;
        const { rows, total } = await this.finanzasService.listarGastos(empresa_id, filtros, solo);
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });
    crearGasto = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const nuevo = await this.finanzasService.crearGasto(empresa_id, req.body, req.user.id);
        res.status(201).json({ success: true, data: nuevo });
    });
    actualizarGasto = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.finanzasService.actualizarGasto(empresa_id, id, req.body) });
    });
    anularGasto = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.finanzasService.anularGasto(empresa_id, id, req.user.id, req.body.motivo) });
    });

    // ---- Ingresos ----
    listarIngresos = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const { limit, offset } = parsePagination(req.query);
        const filtros = {
            desde: fechaQuery(req.query.desde, "desde"),
            hasta: fechaQuery(req.query.hasta, "hasta"),
            metodo_pago: req.query.metodo_pago || null,
            incluirAnulados: boolQuery(req.query.incluir_anulados),
            limit, offset,
        };
        const solo = esAdmin(req) ? null : req.user.id;
        const { rows, total } = await this.finanzasService.listarIngresos(empresa_id, filtros, solo);
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });
    crearIngreso = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const nuevo = await this.finanzasService.crearIngreso(empresa_id, req.body, req.user.id);
        res.status(201).json({ success: true, data: nuevo });
    });
    crearIngresosLote = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const { fecha, lineas } = req.body;
        const creados = await this.finanzasService.crearIngresosLote(empresa_id, fecha, lineas, req.user.id);
        res.status(201).json({ success: true, data: creados, message: `${creados.length} ingresos registrados` });
    });
    actualizarIngreso = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.finanzasService.actualizarIngreso(empresa_id, id, req.body) });
    });
    anularIngreso = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        res.json({ success: true, data: await this.finanzasService.anularIngreso(empresa_id, id, req.user.id, req.body.motivo) });
    });

    // ---- Libro ----
    libro = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const { limit, offset } = parsePagination(req.query);
        const origen = req.query.origen ? String(req.query.origen).toUpperCase() : null;
        if (origen && !["INGRESO", "GASTO", "COMPRA"].includes(origen)) {
            throw ApiError.badRequest("origen debe ser INGRESO, GASTO o COMPRA");
        }
        const filtros = { desde: fechaQuery(req.query.desde, "desde"), hasta: fechaQuery(req.query.hasta, "hasta"), origen, limit, offset };
        const { rows, total } = await this.finanzasService.listarMovimientos(empresa_id, filtros);
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    // ---- Resumen ----
    resumen = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const data = await this.finanzasService.getResumen(empresa_id, {
            desde: req.query.desde, hasta: req.query.hasta, agrupar: req.query.agrupar,
        });
        res.json({ success: true, data });
    });
}

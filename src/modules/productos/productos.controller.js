import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { parsePagination } from "../../utils/pagination.js";
import { parseFiltrosProductos } from "./productos.logic.js";

export default class ProductosController {
    constructor(productosService) {
        this.productosService = productosService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const { limit, offset } = parsePagination(req.query);
        const filtros = parseFiltrosProductos(req.query);
        const { rows, total } = await this.productosService.getAllProductos(empresa_id, { limit, offset, ...filtros });
        res.json({ success: true, data: rows, pagination: { limit, offset, total } });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const producto = await this.productosService.getProductoById(id, empresa_id);
        if (!producto) throw ApiError.notFound("Producto no encontrado");
        res.json({ success: true, data: producto });
    });

    crearProducto = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        const nuevo = await this.productosService.createProducto(req.body, empresa_id);
        res.status(201).json({ success: true, data: nuevo });
    });

    actualizarProducto = asyncHandler(async (req, res) => {
        const { id, empresa_id } = req.params;
        const actualizado = await this.productosService.updateProducto(id, req.body, empresa_id);
        if (!actualizado) throw ApiError.notFound("Producto no encontrado");
        res.json({ success: true, data: actualizado });
    });

    uso = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const producto = await this.productosService.getProductoById(id, empresa_id);
        if (!producto) throw ApiError.notFound("Producto no encontrado");
        res.json({ success: true, data: await this.productosService.getUso(empresa_id, id) });
    });

    eliminarProducto = asyncHandler(async (req, res) => {
        const { id, empresa_id } = req.params;
        const eliminado = await this.productosService.deleteProducto(id, empresa_id);
        if (!eliminado) throw ApiError.notFound("Producto no encontrado");
        res.json({ success: true, message: "Producto eliminado exitosamente" });
    });
}

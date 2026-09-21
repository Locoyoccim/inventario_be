import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

export default class ProveedorController {
    constructor(proveedorService) {
        this.proveedorService = proveedorService;
    }

    listar = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.proveedorService.existsEmpresa(empresa_id)))
            throw ApiError.notFound("Empresa no encontrada");
        res.json({ success: true, data: await this.proveedorService.getAllProveedores(empresa_id) });
    });

    listarPorId = asyncHandler(async (req, res) => {
        const { empresa_id, id } = req.params;
        const proveedor = await this.proveedorService.getProveedorById(empresa_id, id);
        if (!proveedor) throw ApiError.notFound("Proveedor no encontrado");
        res.json({ success: true, data: proveedor });
    });

    crear = asyncHandler(async (req, res) => {
        const { empresa_id } = req.params;
        if (!(await this.proveedorService.existsEmpresa(empresa_id)))
            throw ApiError.badRequest("La empresa asociada no existe");
        const nuevo = await this.proveedorService.createProveedor(req.body, empresa_id);
        res.status(201).json({ success: true, data: nuevo });
    });

    actualizar = asyncHandler(async (req, res) => {
        const { id, empresa_id } = req.params;
        const actualizado = await this.proveedorService.updateProveedor(id, req.body, empresa_id);
        if (!actualizado) throw ApiError.notFound("Proveedor no encontrado");
        res.json({ success: true, data: actualizado });
    });

    eliminar = asyncHandler(async (req, res) => {
        const { id, empresa_id } = req.params;
        await this.proveedorService.deleteProveedor(id, empresa_id);
        res.json({ success: true, message: "Proveedor eliminado exitosamente" });
    });
}

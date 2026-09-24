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
        const incluirInactivos = req.query.incluir_inactivos === "true" || req.query.incluir_inactivos === "1";
        const data = await this.proveedorService.getAllProveedores(empresa_id, { incluirInactivos });
        res.json({ success: true, data });
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

    // Soft-delete: desactiva y devuelve el proveedor.
    eliminar = asyncHandler(async (req, res) => {
        const { id, empresa_id } = req.params;
        // ?definitivo=true borra de verdad (solo si no tiene historial); si no, soft-delete.
        if (req.query.definitivo === "true" || req.query.definitivo === "1") {
            const r = await this.proveedorService.eliminarDefinitivo(empresa_id, id);
            return res.json({ success: true, data: r, message: "Proveedor eliminado definitivamente" });
        }
        const desactivado = await this.proveedorService.deleteProveedor(id, empresa_id);
        res.json({ success: true, data: desactivado, message: "Proveedor desactivado" });
    });

    fusionar = asyncHandler(async (req, res) => {
        const { id, empresa_id } = req.params;
        const r = await this.proveedorService.fusionarProveedor(empresa_id, id, req.body.destino_id);
        res.json({ success: true, data: r, message: "Proveedor fusionado" });
    });

    resumen = asyncHandler(async (req, res) => {
        const { id, empresa_id } = req.params;
        res.json({ success: true, data: await this.proveedorService.resumenProveedor(empresa_id, id) });
    });
}

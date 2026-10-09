import { asyncHandler } from "../../middlewares/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import { registrarEvento } from "../../utils/seguridad.js";
import { listarAccesosSchema } from "./acceso.schema.js";
import { registrarActividadSegura } from "../actividad/actividad.js";

const entero = (valor, nombre) => {
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) throw ApiError.badRequest(`${nombre} inválido`);
    return n;
};

export default class AccesoController {
    constructor(accesoService) {
        this.accesoService = accesoService;
    }

    listar = asyncHandler(async (req, res) => {
        const filtros = listarAccesosSchema.parse(req.query);
        res.json({ success: true, data: await this.accesoService.listar(filtros) });
    });

    conceder = asyncHandler(async (req, res) => {
        const usuario = entero(req.params.id, "usuario");
        const destino = entero(req.params.destino, "empresa");
        const data = await this.accesoService.conceder(req.user, usuario, destino, req.body);
        await registrarActividadSegura(req, {
            empresa_id: destino,
            accion: "acceso.conceder",
            objeto_tipo: "usuario",
            objeto_id: usuario,
            detalle: {
                is_admin: req.body.is_admin ?? true,
                role_id: req.body.role_id ?? null,
                por: "maestro",
            },
        });
        registrarEvento(
            req,
            "acceso_compartido_concedido",
            {
                usuario_destino: usuario,
                empresa_destino: destino,
                is_admin: req.body.is_admin ?? true,
            },
            "info",
        );
        res.json({ success: true, data });
    });

    retirar = asyncHandler(async (req, res) => {
        const usuario = entero(req.params.id, "usuario");
        const destino = entero(req.params.destino, "empresa");
        const data = await this.accesoService.retirar(usuario, destino);
        await registrarActividadSegura(req, {
            empresa_id: destino,
            accion: "acceso.retirar",
            objeto_tipo: "usuario",
            objeto_id: usuario,
            detalle: { por: "maestro" },
        });
        registrarEvento(
            req,
            "acceso_compartido_retirado",
            { usuario_destino: usuario, empresa_destino: destino, por: "maestro" },
            "info",
        );
        res.json({ success: true, data });
    });

    // Owner de la empresa: DELETE /usuarios/:empresa_id/:id/acceso
    retirarComoOwner = asyncHandler(async (req, res) => {
        const destino = entero(req.params.empresa_id, "empresa");
        const usuario = entero(req.params.id, "usuario");
        const data = await this.accesoService.retirarComoOwner(req.user, destino, usuario);
        await registrarActividadSegura(req, {
            empresa_id: destino,
            accion: "acceso.retirar",
            objeto_tipo: "usuario",
            objeto_id: usuario,
            detalle: { por: "owner" },
        });
        registrarEvento(
            req,
            "acceso_compartido_retirado",
            { usuario_destino: usuario, empresa_destino: destino, por: "owner" },
            "info",
        );
        res.json({ success: true, data });
    });
}

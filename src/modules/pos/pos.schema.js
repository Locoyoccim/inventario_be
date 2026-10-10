import { z } from "zod";

const id = z.coerce.number().int().positive();
const texto = (max) => z.string().trim().max(max);
const dineroMax2 = z.coerce
    .number()
    .min(0, "no puede ser negativo")
    .max(1_000_000)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "máximo 2 decimales");

const algunCampo = { message: "Envía al menos un campo" };

export const cuentaCreateSchema = z
    .object({
        tipo: z.enum(["MESA", "LLEVAR"]).default("MESA"),
        mesa_id: id.optional(),
        personas: z.coerce.number().int().min(1).max(99).default(1),
        nombre_cliente: texto(80).optional(),
        reservacion_id: id.optional(),
    })
    .refine((d) => d.tipo === "LLEVAR" || d.mesa_id !== undefined, { message: "Elige la mesa", path: ["mesa_id"] });

export const cuentaUpdateSchema = z
    .object({
        nombre_cliente: texto(80).optional(),
        personas: z.coerce.number().int().min(1).max(99).optional(),
    })
    .refine((d) => d.nombre_cliente !== undefined || d.personas !== undefined, { message: "Envía el nombre o las personas" });

export const itemsCreateSchema = z.object({
    lineas: z
        .array(
            z.object({
                tipo: z.enum(["RECETA", "PRODUCTO"]),
                id,
                cantidad: z.coerce.number().int().min(1).max(99),
                notas: texto(200).optional(),
                // Opciones elegidas (ids de modificadores), a quién se le sirve y en qué tiempo sale.
                opciones: z.array(id).max(30).optional(),
                comensal: z.coerce.number().int().min(1).max(99).optional(),
                tiempo: z.coerce.number().int().min(1).max(6).optional(),
            }),
        )
        .min(1, "Agrega al menos un producto")
        .max(50),
});

export const itemUpdateSchema = z
    .object({
        cantidad: z.coerce.number().int().min(1).max(99).optional(),
        notas: texto(200).optional(),
        comensal: z.coerce.number().int().min(1).max(99).nullable().optional(),
        tiempo: z.coerce.number().int().min(1).max(6).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, algunCampo);

// «Enviar» manda lo pendiente de un tiempo (por defecto el primero); el siguiente tiempo se dispara aparte.
export const enviarSchema = z.object({ tiempo: z.coerce.number().int().min(1).max(6).optional() });

const modificadorSchema = z.object({
    id: id.optional(),
    nombre: texto(60).min(1, "La opción necesita nombre"),
    precio_extra: z.coerce.number().min(0).max(100000).optional(),
    producto_id: id.nullable().optional(),
    cantidad: z.coerce.number().gt(0).max(1000000).nullable().optional(),
}).refine((m) => !m.producto_id || m.cantidad, { message: "Indica cuánto insumo consume la opción", path: ["cantidad"] });

export const grupoOpcionesSchema = z.object({
    nombre: texto(60).min(1, "El grupo necesita nombre"),
    minimo: z.coerce.number().int().min(0).max(20).default(0),
    maximo: z.coerce.number().int().min(1).max(20).default(1),
    modificadores: z.array(modificadorSchema).min(1, "Agrega al menos una opción").max(40),
    articulos: z.array(z.object({ tipo: z.enum(["RECETA", "PRODUCTO"]), id })).max(500).default([]),
});

// Credenciales de un supervisor que autoriza en el equipo de quien no tiene permiso (las mismas del login).
const autorizacion = z.object({ email: texto(120).min(1, "Captura el correo del supervisor"), password: z.string().min(1, "Captura la contraseña del supervisor").max(200) }).optional();

// merma: lo cancelado ya se preparó en cocina o barra; sus insumos se registran como merma (no se vendieron, pero se gastaron).
export const motivoSchema = z.object({ motivo: texto(200).min(1, "Indica el motivo"), merma: z.boolean().optional(), autorizacion });
export const cancelarCuentaSchema = z.object({ motivo: texto(200).optional(), merma: z.boolean().optional(), autorizacion });
export const anularSchema = z.object({ motivo: texto(200).min(1, "Indica el motivo de la anulación"), autorizacion });
export const descuentoSchema = z
    .object({
        tipo: z.enum(["PORCENTAJE", "MONTO", "CORTESIA", "QUITAR"]),
        valor: z.coerce.number().positive("El valor debe ser mayor a 0").max(1_000_000).optional(),
        motivo: texto(200).optional(),
        autorizacion,
    })
    .superRefine((d, ctx) => {
        if ((d.tipo === "PORCENTAJE" || d.tipo === "MONTO") && d.valor === undefined) ctx.addIssue({ code: "custom", path: ["valor"], message: "Captura el valor del descuento" });
        if (d.tipo === "PORCENTAJE" && d.valor !== undefined && d.valor > 100) ctx.addIssue({ code: "custom", path: ["valor"], message: "El porcentaje no puede pasar de 100" });
        if (d.tipo === "MONTO" && d.valor !== undefined && Math.abs(d.valor * 100 - Math.round(d.valor * 100)) > 1e-6) ctx.addIssue({ code: "custom", path: ["valor"], message: "Máximo 2 decimales" });
        if (d.tipo !== "QUITAR" && !d.motivo) ctx.addIssue({ code: "custom", path: ["motivo"], message: "Indica el motivo" });
    });
export const cambiarMesaSchema = z.object({ mesa_id: id });
export const juntarSchema = z.object({ destino_id: id });
export const dividirSchema = z.object({
    partes: z.array(z.object({ item_id: id, cantidad: z.coerce.number().int().min(1).max(99) })).min(1, "Elige qué mover").max(100),
});
const pagosSchema = z
    .array(
        z.object({
            metodo: z.enum(["EFECTIVO", "TARJETA", "TRANSFERENCIA"]),
            monto: dineroMax2.default(0),
            propina: dineroMax2.default(0),
            recibido: dineroMax2.optional(),
            referencia: texto(40).optional(),
        }),
    )
    .max(6, "Máximo 6 pagos por cuenta");

export const cobroSchema = z.object({ pagos: pagosSchema.default([]) });

// Corregir cómo se pagó una cuenta ya cobrada: los pagos nuevos (deben sumar el total) y el motivo.
export const corregirPagoSchema = z.object({
    pagos: pagosSchema.min(1, "Captura al menos un pago"),
    motivo: texto(200).min(1, "Indica el motivo de la corrección"),
    autorizacion,
});
export const turnoCerrarSchema = z.object({
    efectivo_contado: dineroMax2,
    propinas_entregadas: dineroMax2.default(0),
    nota: texto(200).optional(),
});
export const turnoAbrirSchema = z.object({ fondo_inicial: dineroMax2.default(0) });

const nombreImpresora = texto(60).min(1, "nombre es requerido");
const impresoraBase = z.object({
    nombre: nombreImpresora,
    conexion: z.enum(["RED", "USB"]),
    ip: texto(45).min(1).optional(),
    puerto: z.coerce.number().int().min(1).max(65535).optional(),
    nombre_usb: texto(120).min(1).optional(),
    ancho: z.union([z.literal(58), z.literal(80)]).optional(),
    area_id: id.nullable().optional(),
    es_ticket: z.boolean().optional(),
    agente_id: id.nullable().optional(),
});

export const impresoraCreateSchema = impresoraBase
    .refine((d) => (d.conexion === "RED" ? Boolean(d.ip) : Boolean(d.nombre_usb)), { message: "Una impresora de red necesita IP; una USB, el nombre en Windows", path: ["ip"] })
    .refine((d) => Boolean(d.es_ticket) || (d.area_id !== undefined && d.area_id !== null), { message: "Elige el área que atiende o márcala como impresora de tickets", path: ["area_id"] });

export const impresoraUpdateSchema = impresoraBase
    .partial()
    .extend({ activo: z.boolean().optional() })
    .refine((d) => Object.keys(d).length > 0, algunCampo);

export const descartarImpresionesSchema = z.object({ estados: z.array(z.enum(["PENDIENTE", "ERROR", "SIN_IMPRESORA"])).min(1).optional() });
export const agenteCreateSchema = z.object({ nombre: nombreImpresora });
// El instalador canjea el código (sin sesión ni token): solo trae el código y el nombre del equipo donde se instala.
export const emparejarAgenteSchema = z.object({ codigo: z.string().trim().min(8, "Escribe el código completo").max(20), equipo: z.string().trim().max(80).optional() });
export const agenteUpdateSchema = z
    .object({ nombre: nombreImpresora.optional(), activo: z.boolean().optional() })
    .refine((d) => Object.keys(d).length > 0, algunCampo);

export const resultadoImpresionSchema = z.object({ ok: z.boolean(), error: texto(300).optional() });

export const estadoComandaSchema = z.object({ estado: z.enum(["EN_PREPARACION", "LISTA", "ENTREGADA"]) });

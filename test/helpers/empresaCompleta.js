/**
 * Empresa de prueba «completa» para las pruebas de aislamiento: se crea por SQL solo lo mínimo (la empresa y su Admin) y TODO lo
 * demás —catálogo, POS, finanzas, compras...— por la API real, con el token del Admin de esa empresa. Cada recurso lleva en su nombre
 * el marcador de la empresa (`MARCA-A`, `MARCA-B`...): si ese texto aparece en la respuesta a OTRA empresa, es una fuga.
 *
 * `nuevo(tipo)` fabrica una instancia FRESCA del recurso (cada caso de prueba gasta la suya: cobrar, anular, borrar...).
 */
import assert from "node:assert/strict";

let secuencia = 0;
// Único aunque dos procesos de prueba arranquen en el mismo milisegundo: los códigos de ingreso y los correos son únicos GLOBALES.
const unico = () =>
    `${Date.now().toString(36)}${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}${(secuencia++).toString(36)}`;

/** Fecha YYYY-MM-DD desplazada `dias` respecto de hoy (UTC; basta para «ni futura ni lejana»). */
export const fechaRelativa = (dias) =>
    new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);

export class EmpresaPrueba {
    /** @param {{id:number, etiqueta:string, base:string, pool:any, signToken:Function}} o */
    constructor({ id, etiqueta, base, pool, signToken }) {
        Object.assign(this, { id, etiqueta, base, pool, signToken });
        this.marca = `MARCA-${etiqueta}`;
        this.passwordSupervisor = `Sup-${unico()}-clave`;
        this.emailSupervisor = `sup-${etiqueta.toLowerCase()}-${unico()}@aislamiento.test`;
    }

    // ---------- HTTP ----------
    /** Petición con el token indicado (por defecto el Admin de esta empresa). Devuelve {status, texto, json}. */
    async http(metodo, ruta, { token = this.tokAdmin, body, headers = {}, cookie } = {}) {
        const res = await fetch(this.base + ruta, {
            method: metodo,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const texto = await res.text();
        let json = null;
        try {
            json = JSON.parse(texto);
        } catch {
            /* sin cuerpo JSON */
        }
        return {
            status: res.status,
            texto,
            json,
            headers: res.headers,
            cookies: res.headers.getSetCookie(),
        };
    }

    /** Como `http` pero exige 2xx y devuelve `data`. Es la vía de los fixtures: si falla, el mensaje dice qué petición. */
    async crear(metodo, ruta, body, token = this.tokAdmin) {
        const r = await this.http(metodo, ruta, { token, body });
        assert.ok(
            r.status >= 200 && r.status < 300,
            `Fixture ${this.etiqueta}: ${metodo} ${ruta} → ${r.status} ${r.texto.slice(0, 300)}`,
        );
        return r.json?.data;
    }

    // ---------- Alta ----------
    async iniciar() {
        const { pool } = this;
        await pool.query("INSERT INTO empresas (id, nombre) VALUES ($1, $2)", [
            this.id,
            `${this.marca} empresa`,
        ]);
        const u = (
            await pool.query(
                "INSERT INTO usuarios (nombre,codigo_ingreso,email,is_admin,is_owner,empresa_id) VALUES ($1,$1,$2,true,true,$3) RETURNING id",
                [
                    `${this.marca}-admin`,
                    `admin-${this.etiqueta.toLowerCase()}-${this.id}@aislamiento.test`,
                    this.id,
                ],
            )
        ).rows[0];
        this.adminId = u.id;
        this.tokAdmin = this.firmar(u.id, { admin: true });

        // Catálogo de la empresa (028 exige que la categoría exista).
        await this.crear("POST", `/api/categorias/${this.id}`, {
            nombre: `${this.marca} insumo`,
            tipo: "PRODUCTO",
        });
        await this.crear("POST", `/api/categorias/${this.id}`, {
            nombre: `${this.marca} bebidas`,
            tipo: "RECETA",
        });
        this.catInsumo = `${this.marca} insumo`;
        this.catReceta = `${this.marca} bebidas`;
        this.proveedorBase = await this.nuevo("proveedor");
        this.productoBase = await this.nuevo("producto");
        this.recetaBase = await this.nuevo("receta");

        // POS completo: pantalla de cocina encendida (las comandas nacen «NUEVA») e impresoras activas para el ticket y cada área.
        await this.crear("PUT", `/api/empresas/${this.id}/configuracion`, {
            usa_pantalla_cocina: true,
        });
        for (const area of await this.crear("GET", `/api/pos/${this.id}/areas`)) {
            if (!area.imprime) continue;
            await this.crear("PUT", `/api/pos/${this.id}/areas/${area.id}`, { pantalla: true });
            await this.crear("POST", `/api/pos/${this.id}/impresoras`, {
                nombre: `${this.marca} imp ${area.nombre}`,
                conexion: "RED",
                ip: "10.9.9.9",
                area_id: area.id,
            });
        }
        await this.crear("POST", `/api/pos/${this.id}/impresoras`, {
            nombre: `${this.marca} ticket`,
            conexion: "RED",
            ip: "10.9.9.8",
            es_ticket: true,
        });

        // Roles y personas: un mesero (sin permiso de autorizar) y un supervisor con credenciales conocidas.
        const rolMesero = (await pool.query("SELECT id FROM roles WHERE clave = 'mesero'")).rows[0]
            .id;
        const mesero = await this.crear("POST", `/api/usuarios/${this.id}`, {
            nombre: `${this.marca}-mesero`,
            codigo_ingreso: `mes-${this.etiqueta}-${unico()}`,
            role_id: rolMesero,
        });
        this.meseroId = mesero.id;
        this.tokMesero = this.firmar(mesero.id);
        const sup = await this.crear("POST", `/api/usuarios/${this.id}`, {
            nombre: `${this.marca}-supervisor`,
            codigo_ingreso: `sup-${this.etiqueta}-${unico()}`,
            is_admin: true,
            email: this.emailSupervisor,
            password: this.passwordSupervisor,
        });
        this.supervisorId = sup.id;
        // Área donde sale la receta base (con pantalla): las pruebas de filtro por área la usan.
        const menu = await this.crear("GET", `/api/pos/${this.id}/menu`);
        this.areaConPantalla = menu.articulos.find(
            (a) => a.tipo === "RECETA" && a.id === this.recetaBase.id,
        ).area_id;
        return this;
    }

    firmar(usuario_id, { admin = false } = {}) {
        return this.signToken({
            id: usuario_id,
            empresa_id: this.id,
            is_admin: admin,
            is_owner: admin,
            tv: 0,
        });
    }

    // ---------- Recursos frescos ----------
    /** Fabrica una instancia nueva del recurso `tipo` en esta empresa. Devuelve sus ids (y lo que los casos necesiten). */
    async nuevo(tipo, opciones = {}) {
        const f = this.fabricas[tipo];
        assert.ok(f, `No hay fábrica para «${tipo}»`);
        return f.call(this, opciones);
    }

    get fabricas() {
        const E = this.id;
        const nom = (p) => `${this.marca} ${p} ${unico()}`;
        const abrirCuenta = async () => {
            const mesa = await this.crear("POST", `/api/pos/${E}/mesas`, {
                nombre: nom("mesa"),
                capacidad: 4,
            });
            const cuenta = await this.crear("POST", `/api/pos/${E}/cuentas`, {
                tipo: "MESA",
                mesa_id: mesa.id,
            });
            return { id: cuenta.id, mesa_id: mesa.id };
        };
        const conItems = async (c) => {
            const cuenta = await this.crear("POST", `/api/pos/${E}/cuentas/${c.id}/items`, {
                lineas: [{ tipo: "RECETA", id: this.recetaBase.id, cantidad: 2 }],
            });
            return { ...c, item_id: cuenta.items[0].id };
        };
        const enviada = async (c) => {
            const r = await this.crear("POST", `/api/pos/${E}/cuentas/${c.id}/enviar`, {});
            return { ...c, comanda_id: r.comandas[0].id, impresion_id: r.comandas[0].impresion_id };
        };
        return {
            proveedor: async () =>
                this.crear("POST", `/api/proveedores/${E}`, { nombre: nom("proveedor") }),
            categoria: async () =>
                this.crear("POST", `/api/categorias/${E}`, { nombre: nom("cat"), tipo: "AMBAS" }),
            producto: async () => {
                const proveedor_id =
                    this.proveedorBase?.id ??
                    (
                        await this.crear("POST", `/api/proveedores/${E}`, {
                            nombre: nom("prov-base"),
                        })
                    ).id;
                return this.crear("POST", `/api/productos/${E}`, {
                    producto: nom("producto"),
                    unidad_medida: "pz",
                    proveedor_id,
                    categoria: this.catInsumo,
                    cantidad_presentacion: 1,
                    costo_presentacion: 10,
                    stock_actual: 100,
                    stock_minimo: 1,
                });
            },
            receta: async () =>
                this.crear("POST", `/api/recetas/${E}`, {
                    nombre: nom("receta"),
                    categoria: this.catReceta,
                    precio_venta: 55,
                    ingredientes: [{ producto_id: this.productoBase.id, cantidad: 1 }],
                }),
            usuario: async () =>
                this.crear("POST", `/api/usuarios/${E}`, {
                    nombre: nom("usuario"),
                    codigo_ingreso: `u-${this.etiqueta}-${unico()}`,
                }),
            dispositivo: async () => {
                const r = await this.crear("POST", `/api/dispositivos/${E}`, {
                    nombre: nom("equipo"),
                });
                return { id: r.dispositivo.id, codigo: r.codigo };
            },
            compra: async () =>
                (
                    await this.crear("POST", `/api/compras/${E}`, {
                        proveedor_id: this.proveedorBase.id,
                        lineas: [
                            { producto_id: this.productoBase.id, cantidad: 1, costo_total: 10 },
                        ],
                    })
                ).compra,
            pedido: async () =>
                (
                    await this.crear("POST", `/api/compras/${E}/pedido`, {
                        proveedor_id: this.proveedorBase.id,
                        lineas: [
                            { producto_id: this.productoBase.id, cantidad: 1, costo_total: 10 },
                        ],
                    })
                ).compra,
            conteo: async () =>
                (
                    await this.crear("POST", `/api/conteos/${E}`, {
                        lineas: [{ producto_id: this.productoBase.id, stock_fisico: 90 }],
                    })
                ).conteo,
            preparacion: async () =>
                this.crear("POST", `/api/recetas/${E}`, {
                    nombre: nom("preparacion"),
                    categoria: this.catReceta,
                    precio_venta: 0,
                    es_preparacion: true,
                    rendimiento: 10,
                    unidad: "pz",
                    ingredientes: [{ producto_id: this.productoBase.id, cantidad: 1 }],
                }),
            produccion: async () => {
                const prep = await this.nuevo("preparacion");
                const r = await this.crear("POST", `/api/produccion/${E}/confirmar`, {
                    producciones: [{ receta_id: prep.id, lotes: 1 }],
                });
                return { id: r[0].produccion_id, receta_id: prep.id };
            },
            categoriaGasto: async () =>
                this.crear("POST", `/api/finanzas/${E}/categorias-gasto`, {
                    nombre: nom("cat-gasto"),
                }),
            gasto: async () => {
                const cat = await this.nuevo("categoriaGasto");
                return this.crear("POST", `/api/finanzas/${E}/gastos`, {
                    fecha: fechaRelativa(-2),
                    categoria_id: cat.id,
                    concepto: nom("gasto"),
                    monto: 10,
                    metodo_pago: "EFECTIVO",
                });
            },
            ingreso: async () =>
                this.crear("POST", `/api/finanzas/${E}/ingresos`, {
                    fecha: fechaRelativa(-2),
                    metodo_pago: "EFECTIVO",
                    monto: 10,
                    concepto: nom("ingreso"),
                }),
            reservacion: async () =>
                this.crear("POST", `/api/reservaciones/${E}`, {
                    nombre_cliente: nom("cliente"),
                    telefono_cliente: "5550000000",
                    fecha: fechaRelativa(5),
                    hora: "20:00",
                    personas: 2,
                }),
            mesa: async () =>
                this.crear("POST", `/api/pos/${E}/mesas`, { nombre: nom("mesa"), capacidad: 4 }),
            area: async () => this.crear("POST", `/api/pos/${E}/areas`, { nombre: nom("area") }),
            opcion: async () => {
                const g = await this.crear("POST", `/api/pos/${E}/opciones`, {
                    nombre: nom("grupo"),
                    modificadores: [{ nombre: nom("extra"), precio_extra: 5 }],
                    articulos: [{ tipo: "RECETA", id: this.recetaBase.id }],
                });
                return { id: g.id, modificador_id: g.modificadores[0].id };
            },
            // Caja: una por empresa. Devuelve la abierta o abre una nueva (tras cerrarse la anterior).
            turno: async () => {
                const abierto = (await this.http("GET", `/api/pos/${E}/turnos/abierto`)).json?.data;
                if (abierto?.id) return { id: abierto.id };
                return {
                    id: (
                        await this.crear("POST", `/api/pos/${E}/turnos/abrir`, {
                            fondo_inicial: 100,
                        })
                    ).id,
                };
            },
            productoConMovimiento: async () => {
                const p = await this.nuevo("producto");
                await this.crear("POST", `/api/productos/${E}/${p.id}/movimientos`, {
                    tipo_movimiento: "MERMA",
                    cantidad: 1,
                    motivo: "prueba",
                });
                return p;
            },
            // Caja sin cuentas abiertas (cerrar el turno lo exige): cancela las que hayan quedado y deja un turno abierto.
            turnoLimpio: async () => {
                const mapa = await this.crear("GET", `/api/pos/${E}/mapa`);
                const ids = new Set();
                const buscar = (x) => {
                    if (Array.isArray(x)) x.forEach(buscar);
                    else if (x && typeof x === "object") {
                        if (Number.isInteger(x.id) && "folio" in x) ids.add(x.id);
                        Object.values(x).forEach(buscar);
                    }
                };
                buscar(mapa);
                for (const id of ids)
                    await this.http("POST", `/api/pos/${E}/cuentas/${id}/cancelar`, {
                        body: { motivo: "limpieza de caja" },
                    });
                return this.nuevo("turno");
            },
            cuenta: abrirCuenta,
            cuentaConItems: async () => conItems(await abrirCuenta()),
            cuentaEnviada: async () => enviada(await conItems(await abrirCuenta())),
            // Un trabajo de impresión que NO sale por impresora (área sin impresora): queda SIN_IMPRESORA y se puede marcar impreso a mano.
            cuentaSinSalida: async () => {
                const area = await this.nuevo("area");
                const receta = await this.nuevo("receta");
                await this.crear("PUT", `/api/pos/${E}/asignacion-areas/RECETA/${receta.id}`, {
                    area_id: area.id,
                });
                const c = await abrirCuenta();
                await this.crear("POST", `/api/pos/${E}/cuentas/${c.id}/items`, {
                    lineas: [{ tipo: "RECETA", id: receta.id, cantidad: 1 }],
                });
                return enviada(c);
            },
            cuentaPagada: async () => {
                const turno = await this.nuevo("turno");
                const c = await enviada(await conItems(await abrirCuenta()));
                await this.crear("POST", `/api/pos/${E}/cuentas/${c.id}/cobrar`, {
                    pagos: [{ metodo: "EFECTIVO", monto: 110, recibido: 110 }],
                });
                return { ...c, turno_id: turno.id };
            },
            impresora: async () => {
                const area = (await this.crear("GET", `/api/pos/${E}/areas`))[0];
                return this.crear("POST", `/api/pos/${E}/impresoras`, {
                    nombre: nom("impresora"),
                    conexion: "RED",
                    ip: "10.9.9.9",
                    area_id: area.id,
                });
            },
            agente: async () => {
                const r = await this.crear("POST", `/api/pos/${E}/agentes`, {
                    nombre: nom("agente"),
                });
                return { id: r.agente.id, token: r.token, codigo: r.codigo };
            },
            area0: async () => (await this.crear("GET", `/api/pos/${E}/areas`))[0],
        };
    }
}

export default class Usuario {
    constructor(
        id,
        nombre,
        puesto,
        codigo_ingreso,
        is_admin,
        is_owner,
        role_id,
        empresa_id
    ) {
        this.id = id;
        this.nombre = nombre;
        this.codigoIngreso = codigo_ingreso;
        this.puesto = puesto;
        this.is_admin = is_admin;
        this.is_owner = is_owner;
        this.role_id = role_id;
        this.empresa_id = empresa_id;
    }
}

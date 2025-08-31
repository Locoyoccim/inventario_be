# 📦 Inventario App – Backend

Este proyecto es un **sistema de control de inventarios** desarrollado con **Node.js, Express y PostgreSQL**, siguiendo principios de **Clean Code y SOLID**.

---

## ✨ Funcionalidades principales

-   Gestión de usuarios con roles y permisos (owner, admin).
-   Control de empresas y proveedores vinculados.
-   Registro y actualización de inventarios con trazabilidad.
-   Generación de reportes y soporte para lista de compras filtradas por proveedor.

---

## 🛠️ Tecnologías utilizadas

-   **Backend**: Node.js + Express
-   **Base de datos**: PostgreSQL (gestionada con pgAdmin)
-   **Configuración**: variables de entorno con `.env`
-   **ORM / Query Builder**: consultas SQL organizadas

---

## 📌 Instalación y configuración

1. Clonar el repositorio:

    ```bash
    git clone https://github.com/tuusuario/inventarios_app.git
    cd inventarios_app/inventario_BE
    ```

2. Instalar dependencias:

    ```bash
    npm install
    ```

3. Configurar las variables de entorno en un archivo `.env`:

    ```env
    DB_USER=postgres
    DB_HOST=127.0.0.1
    DB_NAME=inventario_db
    DB_PASSWORD=tu_password
    DB_PORT=5432
    ```

4. Iniciar el servidor en modo desarrollo:
    ```bash
    npm run dev
    ```

---

## 📂 Estructura del proyecto

```
project/
│── src/
│   ├── config/         # Configuración (DB, env, etc.)
│   ├── modules/        # Módulos del dominio (Usuarios, Empresas, etc.)
│   ├── routes/         # Definición de rutas
│   ├── utils/          # Funciones reutilizables
│   ├── middlewares/    # Middlewares generales
│   └── app.js          # Inicialización de Express
│
├── .env                # Variables de entorno
├── package.json
└── server.js           # Punto de entrada
```

---

## 🚀 Uso

Ejemplo de consulta a usuarios:

```bash
GET http://localhost:3000/api/usuarios
```

Respuesta:

```json
[
    {
        "id": 7,
        "nombre": "Carlos Ramírez",
        "codigo_ingreso": "CR001",
        "puesto": "Gerente General",
        "is_admin": true,
        "is_owner": true,
        "rol": "owner",
        "empresa": "CotiPro Solutions"
    }
]
```

---

## 🤝 Contribuciones

Las contribuciones son bienvenidas. Abre un issue o pull request para mejoras o correcciones.

---

## 📄 Licencia

Este proyecto está bajo la licencia **MIT**.

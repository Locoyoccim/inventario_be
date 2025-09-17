export default class ProductosController {
    constructor(productosService) {
        this.productosService = productosService;
    }

    listar = async (req, res) => {
        try {
            const productos = await this.productosService.getAllProductos();
            productos ? res.json(productos) : res.json(productos);
        } catch (error) {
            res.status(500).json({ error: "Error al obtener los productos" });
        }
    };

    listarPorId = async (req, res) => {
        const { id } = req.params;
        try {
            const producto = await this.productosService.getProductoById(id);
            producto
                ? res.json(producto)
                : res.status(404).json({ error: "Producto no encontrado" });
        } catch (error) {
            res.status(500).json({ error: "Error al obtener el producto" });
        }
    };

    crearProducto = async (req, res) => {
        const productoData = req.body;
        try {
            const newProducto = await this.productosService.createProducto(productoData);
            res.status(201).json({
                message: "Producto creado exitosamente",
                data: newProducto,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al crear el producto" });
        }
    };

    actualizarProducto = async (req, res) => {
        const { id } = req.params;
        const productoData = req.body;
        try {
            const updatedProducto = await this.productosService.updateProducto(
                id,
                productoData
            );
            res.json({
                message: "Producto actualizado exitosamente",
                data: updatedProducto,
            });
        } catch (error) {
            res.status(500).json({ error: "Error al actualizar el producto" });
        }
    };

    eliminarProducto = async (req, res) => {
        const { id } = req.params;
        try {
            await this.productosService.deleteProducto(id);
            res.json({ message: "Producto eliminado exitosamente" });
        } catch (error) {
            res.status(500).json({ error: "Error al eliminar el producto" });
        }
    };
}

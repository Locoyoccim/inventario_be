import express from "express";
import routes from "./routes/index.js";
import UsuarioService from "./modules/usuarios/usuario.service.js";
import UsuarioRepository from "./modules/usuarios/usuario.repository.js";
import EmpresaRepository from "./modules/empresas/empresa.repository.js";

// Crear instancias de los repositorios
const usuarioRepository = new UsuarioRepository();
const empresaRepository = new EmpresaRepository(); 

// Crear instancia del servicio
const usuarioService = new UsuarioService(usuarioRepository, empresaRepository);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rutas
app.use("/api", routes);

export default app;

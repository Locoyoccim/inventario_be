import express from "express";
import routes from "./routes/index.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rutas
app.use("/api", routes);

export default app;

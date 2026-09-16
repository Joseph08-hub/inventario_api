require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(bodyParser.json());
app.use(cors());

const conexion = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    }
});

conexion.connect(err => {
    if (err) {
        console.error("Error al conectar a Aiven:", err);
        return;
    }
    console.log("Conectado a MySQL (Aiven)");
});

app.get("/", (req, res) => {
    res.send("Bienvenido a Inventario API");
});

app.post("/materiales", (req, res) => {
    const { nombre, cantidad, estado } = req.body;
    const sql = "INSERT INTO materiales (nombre, cantidad, estado) VALUES (?, ?, ?)";
    conexion.query(sql, [nombre, cantidad, estado], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json({ status: "ok", mensaje: "Material registrado" });
        }
    });
});

app.get("/materiales", (req, res) => {
    conexion.query("SELECT * FROM materiales", (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json(result);
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
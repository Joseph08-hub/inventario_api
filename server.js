require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(bodyParser.json());
app.use(cors());

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
});

app.get("/", (req, res) => {
    res.send("Bienvenido a Inventario API");
});

// --- Materiales (Guía 1) ---
app.post("/materiales", (req, res) => {
    const { nombre, cantidad, estado } = req.body;
    const sql = "INSERT INTO materiales (nombre, cantidad, estado) VALUES (?, ?, ?)";
    pool.query(sql, [nombre, cantidad, estado], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json({ status: "ok", mensaje: "Material registrado" });
        }
    });
});

app.get("/materiales", (req, res) => {
    pool.query("SELECT * FROM materiales", (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json(result);
        }
    });
});

// --- Login y roles (Guía 2) ---
app.post("/login", (req, res) => {
    const { usuario, clave } = req.body;
    const sql = "SELECT * FROM usuarios WHERE usuario = ? AND clave = ?";
    pool.query(sql, [usuario, clave], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else if (result.length > 0) {
            res.json({ status: "ok", rol: result[0].rol });
        } else {
            res.json({ status: "fail", mensaje: "Credenciales incorrectas" });
        }
    });
});

// --- Préstamos y devoluciones (Guía 3) ---
app.post("/prestamos", (req, res) => {
    const { material_id, fecha_prestamo, fecha_devolucion, maestro } = req.body;
    const sql = "INSERT INTO prestamos (material_id, fecha_prestamo, fecha_devolucion, maestro) VALUES (?, ?, ?, ?)";
    pool.query(sql, [material_id, fecha_prestamo, fecha_devolucion, maestro], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json({ status: "ok", mensaje: "Préstamo registrado" });
        }
    });
});

app.get("/prestamos", (req, res) => {
    pool.query("SELECT * FROM prestamos", (err, result) => {
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
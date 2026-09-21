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

// --- Préstamos: registrar (Guía 3) ---
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

// --- Préstamos: listar con nombre del material (Guía 4 + mejora de Guía 5) ---
app.get("/prestamos", (req, res) => {
    const sql = `
        SELECT prestamos.id, materiales.nombre AS material,
               prestamos.fecha_prestamo, prestamos.fecha_devolucion, prestamos.maestro
        FROM prestamos
        INNER JOIN materiales ON prestamos.material_id = materiales.id
        ORDER BY prestamos.id DESC
    `;
    pool.query(sql, (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json(result);
        }
    });
});

// --- Préstamos: actualizar fecha de devolución manualmente (Guía 5) ---
app.put("/prestamos/:id", (req, res) => {
    const { fecha_devolucion } = req.body;
    const sql = "UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?";
    pool.query(sql, [fecha_devolucion, req.params.id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json({ status: "ok", mensaje: "Préstamo actualizado" });
        }
    });
});

// --- Préstamos: marcar devolución con la fecha/hora actual (Guía 5) ---
app.put("/prestamos/devolver/:id", (req, res) => {
    const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?";
    pool.query(sql, [req.params.id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json({ status: "ok", mensaje: "Material devuelto" });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
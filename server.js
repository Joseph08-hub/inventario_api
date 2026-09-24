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

// --- Préstamos: registrar, CON validación de permisos (Guía 3 + 8 + 10) ---
app.post("/prestamos", (req, res) => {
    const { material_id, fecha_prestamo, maestro } = req.body;

    const sqlPermiso = "SELECT * FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE";
    pool.query(sqlPermiso, [maestro, material_id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else if (result.length === 0) {
            res.json({ status: "fail", mensaje: "No tienes permiso para prestar este material" });
        } else {
            const sql = "INSERT INTO prestamos (material_id, fecha_prestamo, maestro) VALUES (?, ?, ?)";
            pool.query(sql, [material_id, fecha_prestamo, maestro], (err2, result2) => {
                if (err2) {
                    res.json({ status: "error", mensaje: err2.message });
                } else {
                    res.json({ status: "ok", mensaje: "Préstamo registrado" });
                }
            });
        }
    });
});

// --- Préstamos: listar con nombre del material (Guía 4 + 5) ---
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

// --- Préstamos: marcar devolución por ID de préstamo (usado en la Lista de Préstamos) ---
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

// --- Préstamos: marcar devolución por ID de MATERIAL (usado en escaneo QR, Guía 11) ---
app.put("/prestamos/devolver-material/:material_id", (req, res) => {
    const sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL";
    pool.query(sql, [req.params.material_id], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json({ status: "ok", mensaje: "Entrega registrada" });
        }
    });
});

// --- Reportes (Guía 6 y 7) ---
app.get("/reportes/total", (req, res) => {
    pool.query("SELECT COUNT(*) AS total FROM prestamos", (err, result) => {
        if (err) res.json({ status: "error", mensaje: err.message });
        else res.json(result[0]);
    });
});

app.get("/reportes/pendientes", (req, res) => {
    pool.query("SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL", (err, result) => {
        if (err) res.json({ status: "error", mensaje: err.message });
        else res.json(result[0]);
    });
});

app.get("/reportes/devueltos", (req, res) => {
    pool.query("SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL", (err, result) => {
        if (err) res.json({ status: "error", mensaje: err.message });
        else res.json(result[0]);
    });
});

// --- Notificaciones: préstamos pendientes de un maestro, con nombre del material (Guía 9) ---
app.get("/notificaciones/:maestro", (req, res) => {
    const sql = `
        SELECT prestamos.id, materiales.nombre AS material, prestamos.fecha_prestamo
        FROM prestamos
        INNER JOIN materiales ON prestamos.material_id = materiales.id
        WHERE prestamos.maestro = ? AND prestamos.fecha_devolucion IS NULL
        ORDER BY prestamos.fecha_prestamo ASC
    `;
    pool.query(sql, [req.params.maestro], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json(result);
        }
    });
});

// --- Permisos: asignar permisos a un maestro sobre un material (Guía 10) ---
app.post("/permisos", (req, res) => {
    const { maestro, material_id, puede_ver, puede_prestar, puede_devolver } = req.body;
    const sql = "INSERT INTO permisos (maestro, material_id, puede_ver, puede_prestar, puede_devolver) VALUES (?, ?, ?, ?, ?)";
    pool.query(sql, [maestro, material_id, puede_ver, puede_prestar, puede_devolver], (err, result) => {
        if (err) {
            res.json({ status: "error", mensaje: err.message });
        } else {
            res.json({ status: "ok", mensaje: "Permiso asignado" });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
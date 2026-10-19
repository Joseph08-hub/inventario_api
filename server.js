require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const multer = require("multer");
const QRCode = require("qrcode");

const app = express();
app.use(bodyParser.json());
app.use(cors());

// Clave para firmar los tokens JWT (si no existe la variable JWT_SECRET, usa esta)
const SECRET = process.env.JWT_SECRET || "clave_secreta_inventario";

// ---------------- BASE DE DATOS (Guía 18) ----------------
// Funciona con las variables de Railway (MYSQLHOST, MYSQLUSER...) y con las de
// Render + Aiven (DB_HOST, DB_USER...). Si existen las dos, gana la de Railway.
const baseDatos = {
    host: process.env.MYSQLHOST || process.env.DB_HOST,
    port: process.env.MYSQLPORT || process.env.DB_PORT,
    user: process.env.MYSQLUSER || process.env.DB_USER,
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.DB_NAME
};

// Aiven exige SSL; el MySQL de Railway no lo usa. Se puede forzar con DB_SSL=true o DB_SSL=false.
const usarSSL = process.env.DB_SSL ? process.env.DB_SSL === "true" : !process.env.MYSQLHOST;

const pool = mysql.createPool({
    ...baseDatos,
    ssl: usarSSL ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    dateStrings: true // las fechas llegan como texto "YYYY-MM-DD HH:MM:SS"
});

// Hora de El Salvador (UTC-6) para que NOW() guarde la hora local
pool.on("connection", (conexion) => {
    conexion.query("SET time_zone = '-06:00'");
});

// Avisa en los logs si la conexión a la base de datos funciona
pool.getConnection((err, conexion) => {
    if (err) {
        console.error("No se pudo conectar a la base de datos:", err.message);
    } else {
        console.log("Conexión a la base de datos OK");
        conexion.release();
    }
});

// ---------------- SEGURIDAD (Guía 13) ----------------

function verificarToken(req, res, next) {
    const cabecera = req.headers["authorization"] || "";
    const token = cabecera.replace("Bearer ", "").trim();
    if (!token) {
        return res.status(401).json({ status: "error", mensaje: "Token requerido" });
    }
    jwt.verify(token, SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).json({ status: "error", mensaje: "Sesión expirada, volvé a iniciar sesión" });
        }
        req.usuario = decoded;
        next();
    });
}

function soloAdmin(req, res, next) {
    if (req.usuario.rol !== "admin") {
        return res.status(403).json({ status: "error", mensaje: "Acceso denegado: solo el administrador" });
    }
    next();
}

app.get("/", (req, res) => {
    res.send("Bienvenido a Inventario API");
});

// Login con correo y contraseña (devuelve un token JWT)
app.post("/login", (req, res) => {
    const correo = String(req.body.correo || "").trim();
    const password = String(req.body.password || "");
    pool.query("SELECT * FROM usuarios WHERE correo = ?", [correo], (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        if (result.length === 0) return res.json({ status: "error", mensaje: "Usuario no encontrado" });

        const usuario = result[0];
        const passwordValido = usuario.password && bcrypt.compareSync(password, usuario.password);
        if (!passwordValido) return res.json({ status: "error", mensaje: "Contraseña incorrecta" });

        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol },
            SECRET,
            { expiresIn: "8h" }
        );
        res.json({ status: "ok", token, rol: usuario.rol, id: usuario.id, nombre: usuario.nombre });
    });
});

// Registro de usuarios con contraseña encriptada (solo el administrador puede crear usuarios)
app.post("/registro", verificarToken, soloAdmin, (req, res) => {
    const { nombre, correo, password, rol } = req.body;
    if (!nombre || !correo || !password) {
        return res.json({ status: "error", mensaje: "Completá nombre, correo y contraseña" });
    }
    const rolFinal = rol === "admin" ? "admin" : "maestro";
    const hashedPassword = bcrypt.hashSync(password, 8);
    const sql = "INSERT INTO usuarios (nombre, correo, password, rol) VALUES (?, ?, ?, ?)";
    pool.query(sql, [nombre, correo, hashedPassword, rolFinal], (err) => {
        if (err) {
            const mensaje = err.code === "ER_DUP_ENTRY" ? "Ese correo ya está registrado" : err.message;
            return res.json({ status: "error", mensaje });
        }
        res.json({ status: "ok", mensaje: "Usuario registrado" });
    });
});

// Lista de docentes (maestros) para los selectores por nombre
app.get("/docentes", verificarToken, (req, res) => {
    pool.query("SELECT id, nombre FROM usuarios WHERE rol = 'maestro' ORDER BY nombre", (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result);
    });
});

// ---------------- MATERIALES CON FOTO Y CATEGORÍA (Guía 16) ----------------
// La foto se guarda DENTRO de la base de datos (columna foto MEDIUMBLOB), porque el disco de
// Render y Railway se borra en cada reinicio y una carpeta "uploads/" perdería las imágenes.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

function subirFoto(req, res, next) {
    upload.single("foto")(req, res, (err) => {
        if (err) {
            const mensaje = err.code === "LIMIT_FILE_SIZE" ? "La foto pesa más de 3 MB" : err.message;
            return res.json({ status: "error", mensaje });
        }
        next();
    });
}

// Detecta el tipo de imagen mirando los primeros bytes del archivo
function tipoImagen(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
    if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
    return null;
}

// Nunca se manda la foto en la lista (pesa mucho): solo si tiene foto y su tamaño (sirve de versión)
const COLUMNAS_MATERIAL =
    "id, nombre, cantidad, estado, categoria, (foto IS NOT NULL) AS tiene_foto, COALESCE(LENGTH(foto), 0) AS foto_tam";

app.get("/materiales", verificarToken, (req, res) => {
    pool.query(`SELECT ${COLUMNAS_MATERIAL} FROM materiales ORDER BY nombre`, (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result);
    });
});

// La imagen de un material (pública, para que Image.network la pueda cargar directo)
app.get("/materiales/:id/foto", (req, res) => {
    pool.query("SELECT foto FROM materiales WHERE id = ?", [req.params.id], (err, result) => {
        if (err || result.length === 0 || !result[0].foto) {
            return res.status(404).json({ status: "error", mensaje: "Este material no tiene foto" });
        }
        const foto = result[0].foto;
        res.setHeader("Content-Type", tipoImagen(foto) || "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.send(foto);
    });
});

function leerDatosMaterial(req) {
    const { nombre, categoria, cantidad, estado } = req.body;
    const cantidadNumero = parseInt(cantidad, 10);
    return {
        nombre: String(nombre || "").trim(),
        categoria: categoria ? String(categoria) : null,
        cantidad: Number.isNaN(cantidadNumero) ? 1 : Math.max(cantidadNumero, 0),
        estado: estado ? String(estado) : "Nuevo"
    };
}

// Agregar material (el formulario manda los datos + la foto como multipart)
app.post("/materiales", verificarToken, soloAdmin, subirFoto, (req, res) => {
    const datos = leerDatosMaterial(req);
    if (!datos.nombre) return res.json({ status: "error", mensaje: "El nombre es obligatorio" });

    let foto = null;
    if (req.file) {
        if (!tipoImagen(req.file.buffer)) return res.json({ status: "error", mensaje: "El archivo no es una imagen válida" });
        foto = req.file.buffer;
    }
    const sql = "INSERT INTO materiales (nombre, cantidad, estado, categoria, foto) VALUES (?, ?, ?, ?, ?)";
    pool.query(sql, [datos.nombre, datos.cantidad, datos.estado, datos.categoria, foto], (err) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json({ status: "ok", mensaje: "Material agregado con foto y categoría" });
    });
});

// Editar material (la foto es opcional: si no se manda, se conserva la anterior)
app.put("/materiales/:id", verificarToken, soloAdmin, subirFoto, (req, res) => {
    const datos = leerDatosMaterial(req);
    if (!datos.nombre) return res.json({ status: "error", mensaje: "El nombre es obligatorio" });

    const campos = ["nombre = ?", "cantidad = ?", "estado = ?", "categoria = ?"];
    const params = [datos.nombre, datos.cantidad, datos.estado, datos.categoria];
    if (req.file) {
        if (!tipoImagen(req.file.buffer)) return res.json({ status: "error", mensaje: "El archivo no es una imagen válida" });
        campos.push("foto = ?");
        params.push(req.file.buffer);
    }
    params.push(req.params.id);
    pool.query(`UPDATE materiales SET ${campos.join(", ")} WHERE id = ?`, params, (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        if (result.affectedRows === 0) return res.json({ status: "error", mensaje: "Material no encontrado" });
        res.json({ status: "ok", mensaje: "Material actualizado" });
    });
});

// Eliminar material: si ya tiene préstamos no se puede borrar (se perdería el historial)
app.delete("/materiales/:id", verificarToken, soloAdmin, (req, res) => {
    pool.query("SELECT COUNT(*) AS total FROM prestamos WHERE material_id = ?", [req.params.id], (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        if (result[0].total > 0) {
            return res.json({ status: "error", mensaje: "No se puede eliminar: el material tiene préstamos en el historial" });
        }
        pool.query("DELETE FROM permisos WHERE material_id = ?", [req.params.id], (err2) => {
            if (err2) return res.json({ status: "error", mensaje: err2.message });
            pool.query("DELETE FROM materiales WHERE id = ?", [req.params.id], (err3, resultado) => {
                if (err3) return res.json({ status: "error", mensaje: err3.message });
                if (resultado.affectedRows === 0) return res.json({ status: "error", mensaje: "Material no encontrado" });
                res.json({ status: "ok", mensaje: "Material eliminado" });
            });
        });
    });
});

// ---------------- CÓDIGOS QR PÚBLICOS (Guía 18) ----------------
// En vez de guardar PNG en una carpeta "qrs/" (que se borraría en la nube), el QR se genera
// al momento: https://TU-URL/qr/3.png  devuelve la imagen del QR del material 3.

app.get("/qr/:id", async (req, res) => {
    const id = String(req.params.id).replace(/\.png$/i, "");
    if (!/^\d+$/.test(id)) {
        return res.status(400).json({ status: "error", mensaje: "ID de material inválido" });
    }
    try {
        const png = await QRCode.toBuffer(id, { width: 300, margin: 2 });
        res.setHeader("Content-Type", "image/png");
        res.send(png);
    } catch (e) {
        res.status(500).json({ status: "error", mensaje: "No se pudo generar el QR" });
    }
});

// ---------------- PRÉSTAMOS ----------------

// Registrar préstamo: se elige material y docente por nombre, aquí llegan sus IDs
app.post("/prestamos", verificarToken, (req, res) => {
    const { material_id, fecha_prestamo } = req.body;
    // El maestro solo puede registrar préstamos a su nombre; el admin puede elegir el docente
    const docenteId = req.usuario.rol === "admin" ? req.body.docente_id : req.usuario.id;

    if (!material_id || !docenteId) {
        return res.json({ status: "error", mensaje: "Seleccioná el material y el docente" });
    }

    pool.query("SELECT nombre FROM usuarios WHERE id = ?", [docenteId], (err, docentes) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        if (docentes.length === 0) return res.json({ status: "error", mensaje: "Docente no encontrado" });

        const nombreDocente = docentes[0].nombre;
        const sqlPermiso = "SELECT id FROM permisos WHERE maestro = ? AND material_id = ? AND puede_prestar = TRUE";
        pool.query(sqlPermiso, [nombreDocente, material_id], (err2, permisos) => {
            if (err2) return res.json({ status: "error", mensaje: err2.message });
            if (permisos.length === 0) {
                return res.json({ status: "fail", mensaje: "Sin permiso: el docente no puede prestar este material" });
            }

            const sql = "INSERT INTO prestamos (material_id, docente_id, maestro, fecha_prestamo) VALUES (?, ?, ?, COALESCE(?, NOW()))";
            pool.query(sql, [material_id, docenteId, nombreDocente, fecha_prestamo || null], (err3) => {
                if (err3) return res.json({ status: "error", mensaje: err3.message });
                res.json({ status: "ok", mensaje: "Préstamo registrado" });
            });
        });
    });
});

// Listar préstamos con nombres (JOIN). El maestro solo ve los suyos.
app.get("/prestamos", verificarToken, (req, res) => {
    let sql = `
        SELECT p.id, m.nombre AS material, COALESCE(u.nombre, p.maestro) AS docente,
               p.fecha_prestamo, p.fecha_devolucion
        FROM prestamos p
        JOIN materiales m ON p.material_id = m.id
        LEFT JOIN usuarios u ON p.docente_id = u.id
    `;
    const params = [];
    if (req.usuario.rol !== "admin") {
        sql += " WHERE (p.docente_id = ? OR p.maestro = ?)";
        params.push(req.usuario.id, req.usuario.nombre);
    }
    sql += " ORDER BY p.id DESC";
    pool.query(sql, params, (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result);
    });
});

// Cambiar la fecha de devolución manualmente (solo administrador)
app.put("/prestamos/:id", verificarToken, soloAdmin, (req, res) => {
    const { fecha_devolucion } = req.body;
    pool.query("UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?", [fecha_devolucion, req.params.id], (err) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json({ status: "ok", mensaje: "Préstamo actualizado" });
    });
});

// Marcar devolución desde la lista de préstamos
app.put("/prestamos/devolver/:id", verificarToken, (req, res) => {
    let sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ? AND fecha_devolucion IS NULL";
    const params = [req.params.id];
    if (req.usuario.rol !== "admin") {
        sql += " AND (docente_id = ? OR maestro = ?)";
        params.push(req.usuario.id, req.usuario.nombre);
    }
    pool.query(sql, params, (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        if (result.affectedRows === 0) {
            return res.json({ status: "fail", mensaje: "No se pudo marcar: el préstamo ya está devuelto o no es tuyo" });
        }
        res.json({ status: "ok", mensaje: "Material devuelto" });
    });
});

// Marcar entrega desde el escaneo QR (por ID de material)
app.put("/prestamos/devolver-material/:material_id", verificarToken, (req, res) => {
    let sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE material_id = ? AND fecha_devolucion IS NULL";
    const params = [req.params.material_id];
    if (req.usuario.rol !== "admin") {
        sql += " AND (docente_id = ? OR maestro = ?)";
        params.push(req.usuario.id, req.usuario.nombre);
    }
    pool.query(sql, params, (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        if (result.affectedRows === 0) {
            return res.json({ status: "fail", mensaje: "No hay un préstamo pendiente de este material a tu nombre" });
        }
        res.json({ status: "ok", mensaje: "Entrega registrada" });
    });
});

// ---------------- NOTIFICACIONES ----------------

app.get("/notificaciones", verificarToken, (req, res) => {
    const sql = `
        SELECT p.id, m.nombre AS material, p.fecha_prestamo
        FROM prestamos p
        JOIN materiales m ON p.material_id = m.id
        WHERE (p.docente_id = ? OR p.maestro = ?) AND p.fecha_devolucion IS NULL
        ORDER BY p.fecha_prestamo ASC
    `;
    pool.query(sql, [req.usuario.id, req.usuario.nombre], (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result);
    });
});

// ---------------- PERMISOS ----------------

app.get("/permisos", verificarToken, soloAdmin, (req, res) => {
    const sql = `
        SELECT pe.id, pe.maestro AS docente, m.nombre AS material,
               pe.puede_ver, pe.puede_prestar, pe.puede_devolver
        FROM permisos pe
        JOIN materiales m ON pe.material_id = m.id
        ORDER BY pe.id DESC
    `;
    pool.query(sql, (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result);
    });
});

// Asignar permisos: si ya existía uno para ese docente y material, se reemplaza
app.post("/permisos", verificarToken, soloAdmin, (req, res) => {
    const { docente_id, material_id, puede_ver, puede_prestar, puede_devolver } = req.body;
    if (!docente_id || !material_id) {
        return res.json({ status: "error", mensaje: "Seleccioná el docente y el material" });
    }
    pool.query("SELECT nombre FROM usuarios WHERE id = ?", [docente_id], (err, docentes) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        if (docentes.length === 0) return res.json({ status: "error", mensaje: "Docente no encontrado" });

        const nombre = docentes[0].nombre;
        pool.query("DELETE FROM permisos WHERE maestro = ? AND material_id = ?", [nombre, material_id], (err2) => {
            if (err2) return res.json({ status: "error", mensaje: err2.message });
            const sql = "INSERT INTO permisos (maestro, material_id, puede_ver, puede_prestar, puede_devolver) VALUES (?, ?, ?, ?, ?)";
            pool.query(sql, [nombre, material_id, !!puede_ver, !!puede_prestar, !!puede_devolver], (err3) => {
                if (err3) return res.json({ status: "error", mensaje: err3.message });
                res.json({ status: "ok", mensaje: "Permiso asignado" });
            });
        });
    });
});

// ---------------- REPORTES (Guías 6 y 7, solo administrador) ----------------

app.get("/reportes/total", verificarToken, soloAdmin, (req, res) => {
    pool.query("SELECT COUNT(*) AS total FROM prestamos", (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result[0]);
    });
});

app.get("/reportes/pendientes", verificarToken, soloAdmin, (req, res) => {
    pool.query("SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL", (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result[0]);
    });
});

app.get("/reportes/devueltos", verificarToken, soloAdmin, (req, res) => {
    pool.query("SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL", (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result[0]);
    });
});

// ---------------- REPORTES FILTRADOS (Guía 12) E HISTORIAL (Guía 17) ----------------

// Arma la consulta según los filtros: maestro, material, fecha_inicio y fecha_fin
function construirFiltro(query) {
    const condiciones = [];
    const params = [];
    if (query.maestro && query.maestro !== "todos") {
        condiciones.push("COALESCE(u.nombre, p.maestro) = ?");
        params.push(query.maestro);
    }
    if (query.material && query.material !== "todos") {
        condiciones.push("m.nombre = ?");
        params.push(query.material);
    }
    if (query.fecha_inicio) {
        condiciones.push("DATE(p.fecha_prestamo) >= ?");
        params.push(query.fecha_inicio);
    }
    if (query.fecha_fin) {
        condiciones.push("DATE(p.fecha_prestamo) <= ?");
        params.push(query.fecha_fin);
    }
    const where = condiciones.length > 0 ? "WHERE " + condiciones.join(" AND ") : "";
    const sql = `
        SELECT p.id, m.nombre AS material, m.categoria, COALESCE(u.nombre, p.maestro) AS docente,
               p.fecha_prestamo, p.fecha_devolucion
        FROM prestamos p
        JOIN materiales m ON p.material_id = m.id
        LEFT JOIN usuarios u ON p.docente_id = u.id
        ${where}
        ORDER BY p.fecha_prestamo DESC
    `;
    return { sql, params };
}

function enviarPDF(res, filas, filtros) {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="reporte_prestamos.pdf"');
    doc.pipe(res);

    const xs = [40, 66, 200, 330, 435];
    const anchos = [22, 130, 125, 100, 115];

    function encabezadoTabla(y) {
        doc.rect(40, y - 4, 515, 18).fill("#1E3A8A");
        doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(9);
        ["#", "Material", "Docente", "Préstamo", "Devolución"].forEach((titulo, i) => {
            doc.text(titulo, xs[i], y, { width: anchos[i], height: 12, ellipsis: true });
        });
    }

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#1E3A8A").text("Reporte de Préstamos", { align: "center" });
    doc.font("Helvetica").fontSize(11).fillColor("#333333").text("Inventario Escolar", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#666666").text(
        `Docente: ${filtros.maestro || "Todos"}   Material: ${filtros.material || "Todos"}   Desde: ${filtros.fecha_inicio || "-"}   Hasta: ${filtros.fecha_fin || "-"}   Registros: ${filas.length}`,
        { align: "center" }
    );

    let y = doc.y + 14;
    encabezadoTabla(y);
    y += 22;

    filas.forEach((f, i) => {
        if (y > 770) {
            doc.addPage();
            y = 40;
            encabezadoTabla(y);
            y += 22;
        }
        if (i % 2 === 0) {
            doc.rect(40, y - 4, 515, 16).fill("#F3F4F8");
        }
        doc.fillColor("#000000").font("Helvetica").fontSize(9);
        const valores = [i + 1, f.material, f.docente, f.fecha_prestamo || "-", f.fecha_devolucion || "Pendiente"];
        valores.forEach((valor, c) => {
            doc.text(String(valor), xs[c], y, { width: anchos[c], height: 12, ellipsis: true });
        });
        y += 16;
    });

    if (filas.length === 0) {
        doc.fillColor("#666666").fontSize(10).text("No hay registros para los filtros seleccionados.", 40, y + 10, { width: 515, align: "center" });
    }

    doc.fillColor("#888888").font("Helvetica-Oblique").fontSize(8)
        .text("Creado por Joseph Gabriel Abrego Mármol", 40, 780, { width: 515, align: "center" });
    doc.end();
}

async function enviarExcel(res, filas) {
    const libro = new ExcelJS.Workbook();
    libro.creator = "Inventario Escolar";
    const hoja = libro.addWorksheet("Préstamos");
    hoja.columns = [
        { header: "ID", key: "id", width: 8 },
        { header: "Material", key: "material", width: 30 },
        { header: "Categoría", key: "categoria", width: 18 },
        { header: "Docente", key: "docente", width: 28 },
        { header: "Fecha de préstamo", key: "fecha_prestamo", width: 22 },
        { header: "Fecha de devolución", key: "fecha_devolucion", width: 22 },
        { header: "Estado", key: "estado", width: 14 }
    ];
    const encabezado = hoja.getRow(1);
    encabezado.font = { bold: true, color: { argb: "FFFFFFFF" } };
    encabezado.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };

    filas.forEach((f) => {
        hoja.addRow({
            id: f.id,
            material: f.material,
            categoria: f.categoria || "",
            docente: f.docente,
            fecha_prestamo: f.fecha_prestamo || "",
            fecha_devolucion: f.fecha_devolucion || "",
            estado: f.fecha_devolucion ? "Devuelto" : "Pendiente"
        });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="reporte_prestamos.xlsx"');
    await libro.xlsx.write(res);
    res.end();
}

// Los tres manejadores se usan en las rutas de la Guía 12 (/reportes/...) y de la Guía 17 (/historial...)
function manejarJSON(req, res) {
    const { sql, params } = construirFiltro(req.query);
    pool.query(sql, params, (err, filas) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(filas);
    });
}

function manejarPDF(req, res) {
    const { sql, params } = construirFiltro(req.query);
    pool.query(sql, params, (err, filas) => {
        if (err) return res.status(500).json({ status: "error", mensaje: err.message });
        enviarPDF(res, filas, req.query);
    });
}

function manejarExcel(req, res) {
    const { sql, params } = construirFiltro(req.query);
    pool.query(sql, params, (err, filas) => {
        if (err) return res.status(500).json({ status: "error", mensaje: err.message });
        enviarExcel(res, filas).catch(() => {
            if (!res.headersSent) res.status(500).json({ status: "error", mensaje: "No se pudo generar el Excel" });
            else res.end();
        });
    });
}

app.get("/reportes/filtrados", verificarToken, soloAdmin, manejarJSON);
app.get("/reportes/pdf", verificarToken, soloAdmin, manejarPDF);
app.get("/reportes/excel", verificarToken, soloAdmin, manejarExcel);

app.get("/historial", verificarToken, soloAdmin, manejarJSON);
app.get("/historial/pdf", verificarToken, soloAdmin, manejarPDF);
app.get("/historial/excel", verificarToken, soloAdmin, manejarExcel);

// ---------------- DASHBOARD (Guía 14) ----------------

app.get("/dashboard", verificarToken, soloAdmin, (req, res) => {
    const sql = `
        SELECT
            (SELECT COUNT(*) FROM materiales) AS total_materiales,
            (SELECT COUNT(*) FROM materiales m WHERE NOT EXISTS
                (SELECT 1 FROM prestamos p WHERE p.material_id = m.id AND p.fecha_devolucion IS NULL)) AS disponibles,
            (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NULL) AS prestados,
            (SELECT COUNT(*) FROM prestamos WHERE fecha_devolucion IS NOT NULL) AS devueltos,
            (SELECT COUNT(*) FROM materiales WHERE LOWER(estado) IN ('dañado', 'danado')) AS danados
    `;
    pool.query(sql, (err, result) => {
        if (err) return res.json({ status: "error", mensaje: err.message });
        res.json(result[0]);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
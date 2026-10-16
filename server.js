// ===================================================================
// INVENTARIO ESCOLAR - API (Node.js + Express + MySQL)
// Incluye: Guía 16 (materiales con foto y categoría)
//          Guía 17 (historial con filtros y exportación PDF/Excel)
//          Guía 18 (despliegue en la nube: Render + Aiven)
// ===================================================================
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/qrs", express.static("qrs")); // Guía 18: carpeta de QR como archivos estáticos

const JWT_SECRET = process.env.JWT_SECRET || "cambia_este_secreto_en_render";

// ---------------- CONEXIÓN A LA BASE DE DATOS ----------------
// Acepta variables DB_* (Render/Aiven) o MYSQL* (Railway)
const env = (...nombres) => {
  for (const n of nombres) if (process.env[n]) return process.env[n];
  return undefined;
};
const host = env("DB_HOST", "MYSQLHOST", "MYSQL_HOST");
const usarSSL = process.env.DB_SSL === "true" || (host || "").includes("aivencloud.com");

const pool = mysql.createPool({
  host,
  user: env("DB_USER", "MYSQLUSER", "MYSQL_USER"),
  password: env("DB_PASSWORD", "MYSQLPASSWORD", "MYSQL_PASSWORD"),
  database: env("DB_NAME", "MYSQLDATABASE", "MYSQL_DATABASE"),
  port: Number(env("DB_PORT", "MYSQLPORT", "MYSQL_PORT") || 3306),
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true, // las fechas llegan como "2026-10-15 08:30:00"
  charset: "utf8mb4",
  ssl: usarSSL ? { rejectUnauthorized: false } : undefined,
});
const db = pool.promise();

// Envuelve cada ruta para capturar errores sin tumbar el servidor
const ruta = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ status: "error", mensaje: e.message });
  });

// ---------------- AUTENTICACIÓN ----------------
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ status: "error", mensaje: "Sesión no válida. Iniciá sesión de nuevo" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ status: "error", mensaje: "Sesión vencida. Iniciá sesión de nuevo" });
  }
}

function soloAdmin(req, res, next) {
  if (req.user.rol !== "admin") {
    return res.status(403).json({ status: "error", mensaje: "Solo el administrador puede hacer esto" });
  }
  next();
}

// ---------------- CREACIÓN / ACTUALIZACIÓN DE TABLAS ----------------
async function iniciarBD() {
  await db.query(`CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    correo VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    rol VARCHAR(20) NOT NULL DEFAULT 'maestro'
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS materiales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    cantidad INT DEFAULT 1,
    estado VARCHAR(30) DEFAULT 'Disponible'
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS prestamos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    material_id INT NOT NULL,
    docente_id INT NOT NULL,
    fecha_prestamo DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_devolucion DATETIME NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS permisos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    docente_id INT NOT NULL,
    material_id INT NOT NULL,
    puede_ver TINYINT(1) DEFAULT 1,
    puede_prestar TINYINT(1) DEFAULT 0,
    puede_devolver TINYINT(1) DEFAULT 0
  )`);

  // Guía 16: columnas nuevas. La foto se guarda EN la base de datos (no en disco)
  // porque Render borra los archivos del disco en cada reinicio/despliegue.
  const columnas = ["categoria VARCHAR(50)", "foto_data MEDIUMBLOB", "foto_tipo VARCHAR(50)"];
  for (const col of columnas) {
    try {
      await db.query(`ALTER TABLE materiales ADD COLUMN ${col}`);
    } catch (e) {
      if (e.errno !== 1060) throw e; // 1060 = la columna ya existe
    }
  }

  // Si no hay usuarios, crea un administrador inicial
  const [u] = await db.query("SELECT COUNT(*) AS n FROM usuarios");
  if (u[0].n === 0) {
    const hash = await bcrypt.hash("admin123", 10);
    await db.query("INSERT INTO usuarios (nombre, correo, password, rol) VALUES (?,?,?,?)", [
      "Administrador", "admin@inventario.com", hash, "admin",
    ]);
    console.log("Usuario inicial creado: admin@inventario.com / admin123 (cambialo)");
  }
}

// ---------------- LOGIN Y REGISTRO ----------------
app.post("/login", ruta(async (req, res) => {
  const { correo, password } = req.body;
  const [rows] = await db.query("SELECT * FROM usuarios WHERE correo = ?", [correo]);
  if (!rows.length) return res.json({ status: "error", mensaje: "Correo o contraseña incorrectos" });
  const u = rows[0];
  const guardada = String(u.password || "");
  // Soporta contraseñas con bcrypt y contraseñas antiguas en texto plano
  const ok = guardada.startsWith("$2") ? await bcrypt.compare(String(password), guardada) : guardada === String(password);
  if (!ok) return res.json({ status: "error", mensaje: "Correo o contraseña incorrectos" });
  const token = jwt.sign({ id: u.id, nombre: u.nombre, rol: u.rol }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ status: "ok", token, id: u.id, nombre: u.nombre, rol: u.rol });
}));

app.post("/registro", auth, soloAdmin, ruta(async (req, res) => {
  const { nombre, correo, password, rol } = req.body;
  if (!nombre || !correo || !password) return res.json({ status: "error", mensaje: "Faltan datos" });
  const [existe] = await db.query("SELECT id FROM usuarios WHERE correo = ?", [correo]);
  if (existe.length) return res.json({ status: "error", mensaje: "Ese correo ya está registrado" });
  const hash = await bcrypt.hash(String(password), 10);
  await db.query("INSERT INTO usuarios (nombre, correo, password, rol) VALUES (?,?,?,?)", [
    nombre, correo, hash, rol === "admin" ? "admin" : "maestro",
  ]);
  res.json({ status: "ok", mensaje: "Usuario registrado correctamente" });
}));

app.get("/docentes", auth, ruta(async (req, res) => {
  if (req.user.rol === "admin") {
    const [r] = await db.query("SELECT id, nombre FROM usuarios WHERE rol = 'maestro' ORDER BY nombre");
    return res.json(r);
  }
  const [r] = await db.query("SELECT id, nombre FROM usuarios WHERE id = ?", [req.user.id]);
  res.json(r);
}));

// ===================================================================
// GUÍA 16: MATERIALES CON FOTO Y CATEGORÍA
// ===================================================================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function tipoImagen(file) {
  if (file.mimetype && file.mimetype.startsWith("image/")) return file.mimetype;
  const n = (file.originalname || "").toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

// Lista (sin enviar la imagen, solo si tiene foto)
app.get("/materiales", auth, ruta(async (req, res) => {
  const [r] = await db.query(
    `SELECT id, nombre, cantidad, estado, categoria, (foto_data IS NOT NULL) AS tiene_foto
     FROM materiales ORDER BY nombre`
  );
  res.json(r);
}));

// La foto se sirve como imagen (pública para que Image.network la pueda cargar)
app.get("/materiales/:id/foto", ruta(async (req, res) => {
  const [r] = await db.query("SELECT foto_data, foto_tipo FROM materiales WHERE id = ?", [req.params.id]);
  if (!r.length || !r[0].foto_data) return res.status(404).end();
  res.set("Content-Type", r[0].foto_tipo || "image/jpeg");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(r[0].foto_data);
}));

app.post("/materiales", auth, soloAdmin, upload.single("foto"), ruta(async (req, res) => {
  const { nombre, categoria, estado } = req.body;
  const cantidad = parseInt(req.body.cantidad) || 1;
  if (!nombre || !nombre.trim()) return res.json({ status: "error", mensaje: "El nombre es obligatorio" });
  const foto = req.file ? req.file.buffer : null;
  const tipo = req.file ? tipoImagen(req.file) : null;
  await db.query(
    "INSERT INTO materiales (nombre, cantidad, estado, categoria, foto_data, foto_tipo) VALUES (?,?,?,?,?,?)",
    [nombre.trim(), cantidad, estado || "Disponible", categoria || "Otros", foto, tipo]
  );
  res.json({ status: "ok", mensaje: "Material agregado con foto y categoría" });
}));

app.put("/materiales/:id", auth, soloAdmin, upload.single("foto"), ruta(async (req, res) => {
  const { nombre, categoria, estado, cantidad } = req.body;
  const campos = [];
  const params = [];
  if (nombre !== undefined && nombre.trim() !== "") { campos.push("nombre = ?"); params.push(nombre.trim()); }
  if (categoria !== undefined) { campos.push("categoria = ?"); params.push(categoria); }
  if (estado !== undefined) { campos.push("estado = ?"); params.push(estado); }
  if (cantidad !== undefined && cantidad !== "") { campos.push("cantidad = ?"); params.push(parseInt(cantidad) || 0); }
  if (req.file) {
    campos.push("foto_data = ?", "foto_tipo = ?");
    params.push(req.file.buffer, tipoImagen(req.file));
  }
  if (!campos.length) return res.json({ status: "error", mensaje: "No hay cambios para guardar" });
  params.push(req.params.id);
  const [r] = await db.query(`UPDATE materiales SET ${campos.join(", ")} WHERE id = ?`, params);
  if (!r.affectedRows) return res.json({ status: "error", mensaje: "El material no existe" });
  res.json({ status: "ok", mensaje: "Material actualizado" });
}));

app.delete("/materiales/:id", auth, soloAdmin, ruta(async (req, res) => {
  const [uso] = await db.query("SELECT COUNT(*) AS n FROM prestamos WHERE material_id = ?", [req.params.id]);
  if (uso[0].n > 0) {
    return res.json({
      status: "error",
      mensaje: "No se puede eliminar: el material tiene préstamos en el historial. Cambiale el estado a 'Dañado' o 'Inactivo'.",
    });
  }
  await db.query("DELETE FROM permisos WHERE material_id = ?", [req.params.id]);
  await db.query("DELETE FROM materiales WHERE id = ?", [req.params.id]);
  res.json({ status: "ok", mensaje: "Material eliminado" });
}));

// ---------------- PRÉSTAMOS ----------------
app.get("/prestamos", auth, ruta(async (req, res) => {
  let sql = `SELECT p.id, m.nombre AS material, u.nombre AS docente, p.fecha_prestamo, p.fecha_devolucion
             FROM prestamos p
             JOIN materiales m ON p.material_id = m.id
             JOIN usuarios u ON p.docente_id = u.id`;
  const params = [];
  if (req.user.rol !== "admin") { sql += " WHERE p.docente_id = ?"; params.push(req.user.id); }
  sql += " ORDER BY p.fecha_prestamo DESC";
  const [r] = await db.query(sql, params);
  res.json(r);
}));

app.post("/prestamos", auth, ruta(async (req, res) => {
  const esAdmin = req.user.rol === "admin";
  const material_id = parseInt(req.body.material_id);
  const docente_id = esAdmin ? parseInt(req.body.docente_id) : req.user.id;
  const fecha = req.body.fecha_prestamo || null;
  if (!material_id || !docente_id) return res.json({ status: "error", mensaje: "Seleccioná el material y el docente" });

  const [mat] = await db.query("SELECT id, cantidad FROM materiales WHERE id = ?", [material_id]);
  if (!mat.length) return res.json({ status: "error", mensaje: "El material no existe" });

  if (!esAdmin) {
    const [perm] = await db.query(
      "SELECT puede_prestar FROM permisos WHERE docente_id = ? AND material_id = ? LIMIT 1",
      [docente_id, material_id]
    );
    if (!perm.length || !perm[0].puede_prestar) {
      return res.json({ status: "error", mensaje: "No tenés permiso para prestar este material" });
    }
  }

  const [pend] = await db.query(
    "SELECT COUNT(*) AS n FROM prestamos WHERE material_id = ? AND fecha_devolucion IS NULL", [material_id]
  );
  if (mat[0].cantidad > 0 && pend[0].n >= mat[0].cantidad) {
    return res.json({ status: "error", mensaje: "No hay unidades disponibles de este material" });
  }

  await db.query(
    "INSERT INTO prestamos (material_id, docente_id, fecha_prestamo) VALUES (?, ?, COALESCE(?, NOW()))",
    [material_id, docente_id, fecha]
  );
  res.json({ status: "ok", mensaje: "Préstamo registrado correctamente" });
}));

app.put("/prestamos/devolver/:id", auth, ruta(async (req, res) => {
  let sql = "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ? AND fecha_devolucion IS NULL";
  const params = [req.params.id];
  if (req.user.rol !== "admin") { sql += " AND docente_id = ?"; params.push(req.user.id); }
  const [r] = await db.query(sql, params);
  if (!r.affectedRows) return res.json({ status: "error", mensaje: "No se pudo marcar como devuelto" });
  res.json({ status: "ok", mensaje: "Préstamo marcado como devuelto" });
}));

app.put("/prestamos/devolver-material/:materialId", auth, ruta(async (req, res) => {
  let sql = `SELECT id FROM prestamos WHERE material_id = ? AND fecha_devolucion IS NULL`;
  const params = [req.params.materialId];
  if (req.user.rol !== "admin") { sql += " AND docente_id = ?"; params.push(req.user.id); }
  sql += " ORDER BY fecha_prestamo DESC LIMIT 1";
  const [p] = await db.query(sql, params);
  if (!p.length) return res.json({ status: "error", mensaje: "No hay un préstamo pendiente de este material" });
  await db.query("UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?", [p[0].id]);
  res.json({ status: "ok", mensaje: "Material devuelto correctamente" });
}));

app.put("/prestamos/:id", auth, soloAdmin, ruta(async (req, res) => {
  const { fecha_devolucion } = req.body;
  await db.query("UPDATE prestamos SET fecha_devolucion = ? WHERE id = ?", [fecha_devolucion, req.params.id]);
  res.json({ status: "ok", mensaje: "Fecha de devolución actualizada" });
}));

// ---------------- REPORTES SIMPLES Y DASHBOARD ----------------
app.get("/reportes/total", auth, soloAdmin, ruta(async (req, res) => {
  const [r] = await db.query("SELECT COUNT(*) AS total FROM prestamos");
  res.json({ total: r[0].total });
}));
app.get("/reportes/pendientes", auth, soloAdmin, ruta(async (req, res) => {
  const [r] = await db.query("SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL");
  res.json({ pendientes: r[0].pendientes });
}));
app.get("/reportes/devueltos", auth, soloAdmin, ruta(async (req, res) => {
  const [r] = await db.query("SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL");
  res.json({ devueltos: r[0].devueltos });
}));

app.get("/dashboard", auth, soloAdmin, ruta(async (req, res) => {
  const [[mat]] = await db.query("SELECT COUNT(*) AS n FROM materiales");
  const [[pre]] = await db.query("SELECT COUNT(*) AS n FROM prestamos WHERE fecha_devolucion IS NULL");
  const [[dev]] = await db.query("SELECT COUNT(*) AS n FROM prestamos WHERE fecha_devolucion IS NOT NULL");
  const [[dan]] = await db.query("SELECT COUNT(*) AS n FROM materiales WHERE LOWER(estado) LIKE 'da%'");
  res.json({
    total_materiales: mat.n,
    disponibles: Math.max(mat.n - pre.n - dan.n, 0),
    prestados: pre.n,
    devueltos: dev.n,
    danados: dan.n,
  });
}));

app.get("/notificaciones", auth, ruta(async (req, res) => {
  let sql = `SELECT p.id, m.nombre AS material, p.fecha_prestamo
             FROM prestamos p JOIN materiales m ON p.material_id = m.id
             WHERE p.fecha_devolucion IS NULL`;
  const params = [];
  if (req.user.rol !== "admin") { sql += " AND p.docente_id = ?"; params.push(req.user.id); }
  sql += " ORDER BY p.fecha_prestamo DESC";
  const [r] = await db.query(sql, params);
  res.json(r);
}));

// ---------------- PERMISOS ----------------
app.get("/permisos", auth, soloAdmin, ruta(async (req, res) => {
  const [r] = await db.query(
    `SELECT pe.id, u.nombre AS docente, m.nombre AS material,
            pe.puede_ver, pe.puede_prestar, pe.puede_devolver
     FROM permisos pe
     JOIN usuarios u ON pe.docente_id = u.id
     JOIN materiales m ON pe.material_id = m.id
     ORDER BY u.nombre, m.nombre`
  );
  res.json(r);
}));

app.post("/permisos", auth, soloAdmin, ruta(async (req, res) => {
  const { docente_id, material_id } = req.body;
  const ver = req.body.puede_ver ? 1 : 0;
  const prestar = req.body.puede_prestar ? 1 : 0;
  const devolver = req.body.puede_devolver ? 1 : 0;
  const [ex] = await db.query("SELECT id FROM permisos WHERE docente_id = ? AND material_id = ?", [docente_id, material_id]);
  if (ex.length) {
    await db.query("UPDATE permisos SET puede_ver=?, puede_prestar=?, puede_devolver=? WHERE id=?", [ver, prestar, devolver, ex[0].id]);
    return res.json({ status: "ok", mensaje: "Permiso actualizado" });
  }
  await db.query(
    "INSERT INTO permisos (docente_id, material_id, puede_ver, puede_prestar, puede_devolver) VALUES (?,?,?,?,?)",
    [docente_id, material_id, ver, prestar, devolver]
  );
  res.json({ status: "ok", mensaje: "Permiso asignado" });
}));

// ===================================================================
// GUÍA 17: HISTORIAL CON FILTROS Y EXPORTACIÓN
// Filtros opcionales: maestro, material, fecha_inicio, fecha_fin
// (/reportes/* son los mismos datos, para la pantalla de la Guía 12)
// ===================================================================
async function consultarHistorial(req) {
  const { maestro, material, fecha_inicio, fecha_fin } = req.query;
  let sql = `SELECT p.id, m.nombre AS material, m.categoria AS categoria, u.nombre AS docente,
                    p.fecha_prestamo, p.fecha_devolucion
             FROM prestamos p
             JOIN materiales m ON p.material_id = m.id
             JOIN usuarios u ON p.docente_id = u.id
             WHERE 1=1`;
  const params = [];

  if (req.user.rol !== "admin") {
    sql += " AND p.docente_id = ?"; // el maestro solo ve lo suyo
    params.push(req.user.id);
  } else if (maestro && maestro !== "todos") {
    sql += " AND u.nombre = ?";
    params.push(maestro);
  }
  if (material && material !== "todos") { sql += " AND m.nombre = ?"; params.push(material); }
  if (fecha_inicio) { sql += " AND DATE(p.fecha_prestamo) >= ?"; params.push(fecha_inicio); }
  if (fecha_fin) { sql += " AND DATE(p.fecha_prestamo) <= ?"; params.push(fecha_fin); }
  sql += " ORDER BY p.fecha_prestamo DESC";

  const [rows] = await db.query(sql, params);
  return rows;
}

app.get(["/historial", "/reportes/filtrados"], auth, ruta(async (req, res) => {
  res.json(await consultarHistorial(req));
}));

app.get(["/historial/pdf", "/reportes/pdf"], auth, ruta(async (req, res) => {
  const filas = await consultarHistorial(req);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=historial_prestamos.pdf");
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  doc.pipe(res);

  doc.fontSize(18).text("Historial de Préstamos", { align: "center" });
  doc.fontSize(10).fillColor("#666").text(`Generado: ${new Date().toLocaleString("es-SV")}  |  Registros: ${filas.length}`, { align: "center" });
  doc.moveDown();
  doc.fillColor("#000");

  const x = [40, 80, 220, 340, 450]; // columnas
  const encabezado = () => {
    const y = doc.y;
    doc.fontSize(10).font("Helvetica-Bold");
    doc.text("ID", x[0], y); doc.text("Material", x[1], y); doc.text("Docente", x[2], y);
    doc.text("Préstamo", x[3], y); doc.text("Devolución", x[4], y);
    doc.moveTo(40, y + 14).lineTo(555, y + 14).stroke();
    doc.font("Helvetica");
    doc.y = y + 20;
  };
  encabezado();

  filas.forEach((f) => {
    if (doc.y > 760) { doc.addPage(); encabezado(); }
    const y = doc.y;
    doc.fontSize(9);
    doc.text(String(f.id), x[0], y, { width: 36 });
    doc.text(String(f.material), x[1], y, { width: 135, height: 12, ellipsis: true });
    doc.text(String(f.docente), x[2], y, { width: 115, height: 12, ellipsis: true });
    doc.text(String(f.fecha_prestamo || "").slice(0, 16), x[3], y, { width: 105 });
    doc.text(f.fecha_devolucion ? String(f.fecha_devolucion).slice(0, 16) : "Pendiente", x[4], y, { width: 105 });
    doc.y = y + 16;
  });
  doc.end();
}));

app.get(["/historial/excel", "/reportes/excel"], auth, ruta(async (req, res) => {
  const filas = await consultarHistorial(req);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Historial");
  ws.columns = [
    { header: "ID", key: "id", width: 8 },
    { header: "Material", key: "material", width: 28 },
    { header: "Categoría", key: "categoria", width: 16 },
    { header: "Docente", key: "docente", width: 28 },
    { header: "Fecha préstamo", key: "fecha_prestamo", width: 20 },
    { header: "Fecha devolución", key: "fecha_devolucion", width: 20 },
    { header: "Estado", key: "estado", width: 12 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
  filas.forEach((f) =>
    ws.addRow({ ...f, fecha_devolucion: f.fecha_devolucion || "", estado: f.fecha_devolucion ? "Devuelto" : "Pendiente" })
  );
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=historial_prestamos.xlsx");
  await wb.xlsx.write(res);
  res.end();
}));

// ---------------- RUTA DE PRUEBA Y ERRORES ----------------
app.get("/", (req, res) => res.json({ status: "ok", mensaje: "API Inventario Escolar funcionando" }));

app.use((err, req, res, next) => {
  const mensaje = err.code === "LIMIT_FILE_SIZE" ? "La foto es muy pesada (máximo 5 MB)" : err.message;
  res.status(400).json({ status: "error", mensaje });
});

// ---------------- ARRANQUE ----------------
const PUERTO = process.env.PORT || 3000;
iniciarBD()
  .then(() => app.listen(PUERTO, "0.0.0.0", () => console.log("Servidor corriendo en el puerto " + PUERTO)))
  .catch((e) => {
    console.error("No se pudo conectar/preparar la base de datos:", e.message);
    process.exit(1);
  });
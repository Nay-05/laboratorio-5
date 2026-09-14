'use strict';
/**
 * server.js
 * Sistema de Venta de Entradas — Entrada de la Virgen de Guadalupe
 *
 * Servidor HTTP construido sobre el módulo nativo `http` de Node.js
 * (no requiere `npm install` para arrancar: sólo la generación gráfica
 * del QR usa el paquete opcional "qrcode"). Expone una API REST
 * consumida por la interfaz web (public/) y por el cliente de
 * escritorio en Java (java-client/).
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, hashPassword } = require('./db');
const { generarQRDataURL, disponible: qrDisponible } = require('./qr');

const PORT = process.env.PORT || 3000;
const LOCK_MINUTOS = 5; // Control de concurrencia: bloqueo temporal del puesto
const LIMITE_ENTRADAS_POR_CI = 2;

// Tokens de sesión en memoria: token -> { codigo, distrito, usuario }
const sesiones = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (e) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function auditar(ventanilla, accion, detalle) {
  db.prepare(
    'INSERT INTO auditoria (ventanilla_codigo, accion, detalle, fecha) VALUES (?,?,?,?)'
  ).run(ventanilla || null, accion, detalle ? JSON.stringify(detalle) : null, new Date().toISOString());
}

function getSesion(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  return sesiones.get(token) || null;
}

function limpiarBloqueosExpirados() {
  db.prepare("DELETE FROM bloqueos WHERE expira < ?").run(new Date().toISOString());
}
setInterval(limpiarBloqueosExpirados, 30 * 1000).unref();

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) {
  // pattern soporta ":param"
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, keys, handler });
}

// ---- AUTH -------------------------------------------------------------
route('POST', '/api/auth/login', async (req, res) => {
  const body = await readBody(req);
  const { usuario, password } = body;
  const row = db
    .prepare('SELECT * FROM ventanillas WHERE usuario = ? AND activo = 1')
    .get(usuario);
  if (!row || row.password_hash !== hashPassword(password || '')) {
    return send(res, 401, { error: 'Usuario o contraseña incorrectos' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sesiones.set(token, {
    codigo: row.codigo,
    distrito: row.distrito,
    usuario: row.usuario,
    sector_restringido: row.sector_restringido,
    rol: row.rol || 'CAJERO',
  });
  auditar(row.codigo, 'LOGIN', { usuario });
  send(res, 200, { token, ventanilla: row.codigo, distrito: row.distrito, rol: row.rol || 'CAJERO' });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  sesiones.delete(token);
  send(res, 200, { ok: true });
});

function requireAuth(handler) {
  return async (req, res, params) => {
    const sesion = getSesion(req);
    if (!sesion) return send(res, 401, { error: 'Sesión inválida. Inicie sesión.' });
    return handler(req, res, params, sesion);
  };
}

// Igual que requireAuth, pero además exige que la sesión tenga rol ADMIN.
// Se usa para las rutas del panel de administración (editar sectores,
// precios y ventanillas; ver el dashboard de reportes).
function requireAdmin(handler) {
  return requireAuth(async (req, res, params, sesion) => {
    if (sesion.rol !== 'ADMIN') {
      return send(res, 403, { error: 'Esta acción requiere una cuenta de administrador.' });
    }
    return handler(req, res, params, sesion);
  });
}

// ---- ADMINISTRACIÓN: SECTORES (editar nombre, precio, cupos, color) ------
route('GET', '/api/admin/sectores', requireAdmin(async (req, res) => {
  const sectores = db.prepare('SELECT * FROM sectores ORDER BY id').all();
  send(res, 200, sectores);
}));

route('PUT', '/api/admin/sectores/:id', requireAdmin(async (req, res, { id }, sesion) => {
  const actual = db.prepare('SELECT * FROM sectores WHERE id = ?').get(id);
  if (!actual) return send(res, 404, { error: 'Sector no encontrado' });

  const body = await readBody(req);
  const nombre = body.nombre !== undefined ? String(body.nombre).trim() : actual.nombre;
  const tramo = body.tramo !== undefined ? String(body.tramo).trim() : actual.tramo;
  const precio = body.precio !== undefined ? Number(body.precio) : actual.precio;
  const color = body.color !== undefined ? String(body.color).trim() : actual.color;
  const cupos_totales = body.cupos_totales !== undefined ? Number(body.cupos_totales) : actual.cupos_totales;
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : actual.activo;

  if (!nombre || !tramo) return send(res, 400, { error: 'nombre y tramo no pueden quedar vacíos' });
  if (!(precio >= 0)) return send(res, 400, { error: 'El precio debe ser un número mayor o igual a 0' });
  if (!(cupos_totales >= 0)) return send(res, 400, { error: 'Los cupos totales deben ser un número mayor o igual a 0' });

  db.prepare(
    'UPDATE sectores SET nombre = ?, tramo = ?, precio = ?, color = ?, cupos_totales = ?, activo = ? WHERE id = ?'
  ).run(nombre, tramo, precio, color, cupos_totales, activo, id);

  auditar(sesion.codigo, 'ADMIN_EDITA_SECTOR', { id, nombre, precio, cupos_totales, activo });
  send(res, 200, db.prepare('SELECT * FROM sectores WHERE id = ?').get(id));
}));

// ---- ADMINISTRACIÓN: VENTANILLAS (crear/editar cajeros y ventanillas) ----
route('GET', '/api/admin/ventanillas', requireAdmin(async (req, res) => {
  const ventanillas = db
    .prepare(
      `SELECT v.codigo, v.distrito, v.usuario, v.sector_restringido, v.rol, v.activo, s.nombre AS sector_nombre
       FROM ventanillas v LEFT JOIN sectores s ON s.id = v.sector_restringido
       ORDER BY v.rol DESC, v.codigo`
    )
    .all();
  send(res, 200, ventanillas);
}));

route('POST', '/api/admin/ventanillas', requireAdmin(async (req, res, params, sesion) => {
  const body = await readBody(req);
  const { codigo, distrito, usuario, password, sector_restringido, rol } = body;
  if (!codigo || !distrito || !usuario || !password) {
    return send(res, 400, { error: 'codigo, distrito, usuario y password son obligatorios' });
  }
  const yaExiste = db.prepare('SELECT 1 FROM ventanillas WHERE codigo = ? OR usuario = ?').get(codigo, usuario);
  if (yaExiste) return send(res, 409, { error: 'Ya existe una ventanilla con ese código o usuario' });

  db.prepare(
    'INSERT INTO ventanillas (codigo, distrito, usuario, password_hash, sector_restringido, rol) VALUES (?,?,?,?,?,?)'
  ).run(codigo, distrito, usuario, hashPassword(password), sector_restringido || null, rol === 'ADMIN' ? 'ADMIN' : 'CAJERO');

  auditar(sesion.codigo, 'ADMIN_CREA_VENTANILLA', { codigo, usuario });
  send(res, 201, { ok: true });
}));

route('PUT', '/api/admin/ventanillas/:codigo', requireAdmin(async (req, res, { codigo }, sesion) => {
  const actual = db.prepare('SELECT * FROM ventanillas WHERE codigo = ?').get(codigo);
  if (!actual) return send(res, 404, { error: 'Ventanilla no encontrada' });

  const body = await readBody(req);
  const distrito = body.distrito !== undefined ? String(body.distrito).trim() : actual.distrito;
  const sector_restringido = body.sector_restringido !== undefined ? (body.sector_restringido || null) : actual.sector_restringido;
  const rol = body.rol !== undefined ? (body.rol === 'ADMIN' ? 'ADMIN' : 'CAJERO') : actual.rol;
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : actual.activo;

  db.prepare(
    'UPDATE ventanillas SET distrito = ?, sector_restringido = ?, rol = ?, activo = ? WHERE codigo = ?'
  ).run(distrito, sector_restringido, rol, activo, codigo);

  if (body.password) {
    db.prepare('UPDATE ventanillas SET password_hash = ? WHERE codigo = ?').run(hashPassword(body.password), codigo);
  }

  auditar(sesion.codigo, 'ADMIN_EDITA_VENTANILLA', { codigo, distrito, rol, activo });
  send(res, 200, db.prepare('SELECT codigo, distrito, usuario, sector_restringido, rol, activo FROM ventanillas WHERE codigo = ?').get(codigo));
}));

// ---- SECTORES -----------------------------------------------------------
route('GET', '/api/sectores', requireAuth(async (req, res, params, sesion) => {
  let sectores = db.prepare('SELECT * FROM sectores WHERE activo = 1 ORDER BY id').all();
  if (sesion.sector_restringido) {
    sectores = sectores.filter((s) => s.id === sesion.sector_restringido);
  }
  // cupos disponibles = totales - vendidos - bloqueados vigentes
  limpiarBloqueosExpirados();
  const out = sectores.map((s) => {
    const vendidos = db
      .prepare("SELECT COUNT(*) n FROM entradas WHERE sector_id = ? AND estado != 'ANULADA'")
      .get(s.id).n;
    const bloqueados = db
      .prepare('SELECT COUNT(*) n FROM bloqueos WHERE sector_id = ?')
      .get(s.id).n;
    return { ...s, disponibles: s.cupos_totales - vendidos - bloqueados };
  });
  send(res, 200, out);
}));

// Puestos ocupados/bloqueados de un sector (para pintar el mapa de asientos)
route('GET', '/api/sectores/:id/puestos', requireAuth(async (req, res, { id }) => {
  limpiarBloqueosExpirados();
  const vendidos = db
    .prepare("SELECT puesto FROM entradas WHERE sector_id = ? AND estado != 'ANULADA'")
    .all(id)
    .map((r) => r.puesto);
  const bloqueados = db
    .prepare('SELECT puesto, ventanilla_codigo, expira FROM bloqueos WHERE sector_id = ?')
    .all(id);
  send(res, 200, { vendidos, bloqueados });
}));

// ---- COMPRADORES (búsqueda / validación por CI) --------------------------
route('GET', '/api/compradores/:ci', requireAuth(async (req, res, { ci }) => {
  const comprador = db.prepare('SELECT * FROM compradores WHERE ci = ?').get(ci);
  const entradasActivas = db
    .prepare("SELECT e.*, s.nombre AS sector_nombre FROM entradas e JOIN sectores s ON s.id = e.sector_id WHERE e.ci = ? AND e.estado != 'ANULADA'")
    .all(ci);
  send(res, 200, {
    comprador: comprador || null,
    entradas: entradasActivas,
    cantidad: entradasActivas.length,
    limite: LIMITE_ENTRADAS_POR_CI,
    puedeComprar: entradasActivas.length < LIMITE_ENTRADAS_POR_CI,
  });
}));

// ---- BLOQUEO TEMPORAL (control de concurrencia) --------------------------
route('POST', '/api/bloqueos', requireAuth(async (req, res, params, sesion) => {
  const body = await readBody(req);
  const { sector_id, puesto } = body;
  if (!sector_id || !puesto) return send(res, 400, { error: 'sector_id y puesto son obligatorios' });

  limpiarBloqueosExpirados();

  const yaVendido = db
    .prepare("SELECT 1 FROM entradas WHERE sector_id = ? AND puesto = ? AND estado != 'ANULADA'")
    .get(sector_id, puesto);
  if (yaVendido) return send(res, 409, { error: 'Ese puesto ya fue vendido.' });

  const bloqueoExistente = db
    .prepare('SELECT * FROM bloqueos WHERE sector_id = ? AND puesto = ?')
    .get(sector_id, puesto);
  if (bloqueoExistente && bloqueoExistente.ventanilla_codigo !== sesion.codigo) {
    return send(res, 409, {
      error: `Puesto reservado temporalmente por otra ventanilla (${bloqueoExistente.ventanilla_codigo}). Intente en unos minutos.`,
    });
  }

  const ahora = new Date();
  const expira = new Date(ahora.getTime() + LOCK_MINUTOS * 60 * 1000);
  db.prepare(
    `INSERT INTO bloqueos (sector_id, puesto, ventanilla_codigo, creado, expira)
     VALUES (?,?,?,?,?)
     ON CONFLICT(sector_id, puesto) DO UPDATE SET
       ventanilla_codigo = excluded.ventanilla_codigo,
       creado = excluded.creado,
       expira = excluded.expira`
  ).run(sector_id, puesto, sesion.codigo, ahora.toISOString(), expira.toISOString());

  send(res, 200, { ok: true, expira: expira.toISOString(), minutos: LOCK_MINUTOS });
}));

route('DELETE', '/api/bloqueos/:sectorId/:puesto', requireAuth(async (req, res, { sectorId, puesto }, sesion) => {
  db.prepare('DELETE FROM bloqueos WHERE sector_id = ? AND puesto = ? AND ventanilla_codigo = ?')
    .run(sectorId, puesto, sesion.codigo);
  send(res, 200, { ok: true });
}));

// ---- VENTA DE ENTRADA -----------------------------------------------------
route('POST', '/api/entradas', requireAuth(async (req, res, params, sesion) => {
  const body = await readBody(req);
  const { ci, nombre, telefono, sector_id, puesto, checklist } = body;

  // 1) Validar checklist de documentación obligatoria
  const requeridos = ['cedula', 'facturaLuz', 'impuestos'];
  const faltantes = requeridos.filter((k) => !checklist || checklist[k] !== true);
  if (faltantes.length) {
    return send(res, 400, {
      error: 'Falta validar documentación obligatoria',
      faltantes,
    });
  }

  if (!ci || !nombre || !sector_id || !puesto) {
    return send(res, 400, { error: 'ci, nombre, sector_id y puesto son obligatorios' });
  }

  // 2) Control de límite global (máx. 2 entradas por CI, en cualquier ventanilla)
  const entradasActuales = db
    .prepare("SELECT COUNT(*) n FROM entradas WHERE ci = ? AND estado != 'ANULADA'")
    .get(ci).n;
  if (entradasActuales >= LIMITE_ENTRADAS_POR_CI) {
    auditar(sesion.codigo, 'VENTA_RECHAZADA_LIMITE', { ci });
    return send(res, 409, {
      error: `La C.I. ${ci} ya alcanzó el límite de ${LIMITE_ENTRADAS_POR_CI} entradas.`,
    });
  }

  // 3) El sector debe existir y respetar restricción de ventanilla/distrito
  const sector = db.prepare('SELECT * FROM sectores WHERE id = ? AND activo = 1').get(sector_id);
  if (!sector) return send(res, 404, { error: 'Sector inválido' });
  if (sesion.sector_restringido && sesion.sector_restringido !== sector.id) {
    return send(res, 403, { error: 'Esta ventanilla no está autorizada a vender este sector.' });
  }

  // 4) El puesto no debe estar vendido, y si hay bloqueo, debe pertenecer a esta ventanilla
  limpiarBloqueosExpirados();
  const yaVendido = db
    .prepare("SELECT 1 FROM entradas WHERE sector_id = ? AND puesto = ? AND estado != 'ANULADA'")
    .get(sector_id, puesto);
  if (yaVendido) return send(res, 409, { error: 'Ese puesto ya fue vendido.' });

  const bloqueo = db.prepare('SELECT * FROM bloqueos WHERE sector_id = ? AND puesto = ?').get(sector_id, puesto);
  if (!bloqueo || bloqueo.ventanilla_codigo !== sesion.codigo) {
    return send(res, 409, {
      error: 'El puesto no está reservado por esta ventanilla. Vuelva a seleccionarlo (bloqueo temporal expirado o tomado por otra ventanilla).',
    });
  }

  // 5) Registrar comprador (upsert) y la venta, en una transacción
  const fecha = new Date().toISOString();
  const codigoValidacion = `GDL-${sector_id}-${puesto}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO compradores (ci, nombre, telefono) VALUES (?,?,?)
       ON CONFLICT(ci) DO UPDATE SET nombre = excluded.nombre, telefono = excluded.telefono`
    ).run(ci, nombre, telefono || null);

    const info = db
      .prepare(
        `INSERT INTO entradas (ci, sector_id, puesto, ventanilla_codigo, distrito, precio, codigo_validacion, estado, fecha)
         VALUES (?,?,?,?,?,?,?, 'ACTIVA', ?)`
      )
      .run(ci, sector_id, puesto, sesion.codigo, sesion.distrito, sector.precio, codigoValidacion, fecha);

    db.prepare('DELETE FROM bloqueos WHERE sector_id = ? AND puesto = ?').run(sector_id, puesto);

    db.exec('COMMIT');

    const entradaId = info.lastInsertRowid;
    auditar(sesion.codigo, 'VENTA', { entradaId, ci, sector_id, puesto });

    send(res, 201, {
      id: entradaId,
      ci,
      nombre,
      sector: sector.nombre,
      tramo: sector.tramo,
      puesto,
      precio: sector.precio,
      ventanilla: sesion.codigo,
      distrito: sesion.distrito,
      codigo_validacion: codigoValidacion,
      fecha,
    });
  } catch (e) {
    db.exec('ROLLBACK');
    send(res, 500, { error: 'No se pudo registrar la venta: ' + e.message });
  }
}));

// ---- TICKET (para impresión térmica, incluye QR) --------------------------
route('GET', '/api/entradas/:id/ticket', requireAuth(async (req, res, { id }) => {
  const e = db
    .prepare(
      `SELECT e.*, c.nombre, s.nombre AS sector_nombre, s.tramo
       FROM entradas e
       JOIN compradores c ON c.ci = e.ci
       JOIN sectores s ON s.id = e.sector_id
       WHERE e.id = ?`
    )
    .get(id);
  if (!e) return send(res, 404, { error: 'Entrada no encontrada' });

  const qrDataUrl = await generarQRDataURL(e.codigo_validacion);
  send(res, 200, {
    ci: e.ci,
    nombre: e.nombre,
    distrito: e.distrito,
    ventanilla: e.ventanilla_codigo,
    sector: e.sector_nombre,
    tramo: e.tramo,
    puesto: e.puesto,
    precio: e.precio,
    codigo_validacion: e.codigo_validacion,
    fecha: e.fecha,
    qr: qrDataUrl, // null si el paquete "qrcode" no está instalado
    qrDisponible: qrDisponible(),
  });
}));

// ---- VALIDACIÓN DE INGRESO (control de acceso con el código QR) ----------
route('POST', '/api/validar', requireAuth(async (req, res) => {
  const body = await readBody(req);
  const { codigo_validacion } = body;
  const e = db.prepare('SELECT * FROM entradas WHERE codigo_validacion = ?').get(codigo_validacion);
  if (!e) return send(res, 404, { valido: false, error: 'Código no encontrado' });
  if (e.estado === 'ANULADA') return send(res, 200, { valido: false, error: 'Entrada anulada' });
  if (e.estado === 'INGRESADA') return send(res, 200, { valido: false, error: 'El código ya fue utilizado para ingresar' });

  db.prepare("UPDATE entradas SET estado = 'INGRESADA' WHERE id = ?").run(e.id);
  send(res, 200, { valido: true, entrada: e });
}));

// ---- REPORTES ---------------------------------------------------------
route('GET', '/api/reportes/resumen', requireAuth(async (req, res) => {
  const porSector = db
    .prepare(
      `SELECT s.id, s.nombre, s.precio, s.cupos_totales,
              COUNT(e.id) AS vendidos,
              COALESCE(SUM(e.precio),0) AS recaudado
       FROM sectores s
       LEFT JOIN entradas e ON e.sector_id = s.id AND e.estado != 'ANULADA'
       GROUP BY s.id ORDER BY s.id`
    )
    .all();

  // Ventas y recaudación por ventanilla (incluye distrito para el dashboard).
  // Se listan también las ventanillas que aún no vendieron nada (LEFT JOIN),
  // y se excluye la cuenta de administración porque no vende entradas.
  const porVentanilla = db
    .prepare(
      `SELECT v.codigo, v.distrito,
              COUNT(e.id) AS vendidos,
              COALESCE(SUM(e.precio),0) AS recaudado
       FROM ventanillas v
       LEFT JOIN entradas e ON e.ventanilla_codigo = v.codigo AND e.estado != 'ANULADA'
       WHERE v.rol != 'ADMIN'
       GROUP BY v.codigo ORDER BY v.codigo`
    )
    .all();

  const totales = db
    .prepare("SELECT COUNT(*) entradas, COALESCE(SUM(precio),0) recaudado FROM entradas WHERE estado != 'ANULADA'")
    .get();

  const ingresadas = db
    .prepare("SELECT COUNT(*) n FROM entradas WHERE estado = 'INGRESADA'")
    .get().n;

  send(res, 200, { porSector, porVentanilla, totales, ingresadas });
}));

// ---------------------------------------------------------------------------
// Archivos estáticos (frontend)
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Prohibido' });
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No encontrado');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = m[i + 1]));
    try {
      return await r.handler(req, res, params);
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: 'Error interno del servidor', detalle: e.message });
    }
  }
  send(res, 404, { error: 'Ruta no encontrada' });
});

server.listen(PORT, () => {
  console.log(`\n=== Sistema de Venta de Entradas — Entrada Virgen de Guadalupe ===`);
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log(`QR gráfico ${qrDisponible() ? 'DISPONIBLE' : 'NO instalado (ejecute: npm install)'}\n`);
  console.log('Ventanillas de demo: cajero1/1234, cajero2/1234, cajero3/1234');
});

module.exports = server;

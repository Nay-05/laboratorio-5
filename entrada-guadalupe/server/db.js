'use strict';
/**
 * db.js
 * Capa de acceso a datos del Sistema de Venta de Entradas
 * "Entrada de la Virgen de Guadalupe"
 *
 * Usa el módulo nativo `node:sqlite` (incluido en Node.js 22+, sin
 * necesidad de instalar dependencias). El archivo físico de la base
 * de datos se guarda en /database/entradas.db
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_DIR = path.join(__dirname, '..', 'database');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'entradas.db');

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// ESQUEMA
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS sectores (
  id            INTEGER PRIMARY KEY,
  nombre        TEXT NOT NULL,          -- "Sector 1", "Sector 2", ...
  tramo         TEXT NOT NULL,          -- descripción del recorrido
  precio        REAL NOT NULL,
  color         TEXT NOT NULL DEFAULT '#cccccc',
  cupos_totales INTEGER NOT NULL DEFAULT 100,
  activo        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ventanillas (
  codigo        TEXT PRIMARY KEY,       -- Ej: "V-01"
  distrito      TEXT NOT NULL,
  usuario       TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  sector_restringido INTEGER,           -- id de sector si la ventanilla está
                                         -- limitada a un sector/distrito, NULL = todos
  rol           TEXT NOT NULL DEFAULT 'CAJERO', -- 'CAJERO' | 'ADMIN'
  activo        INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (sector_restringido) REFERENCES sectores(id)
);

CREATE TABLE IF NOT EXISTS compradores (
  ci            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  telefono      TEXT
);

CREATE TABLE IF NOT EXISTS entradas (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ci                TEXT NOT NULL,
  sector_id         INTEGER NOT NULL,
  puesto            TEXT NOT NULL,        -- Nº de puesto / metro lineal
  ventanilla_codigo TEXT NOT NULL,
  distrito          TEXT NOT NULL,
  precio            REAL NOT NULL,
  codigo_validacion TEXT UNIQUE NOT NULL, -- dato codificado en el QR
  estado            TEXT NOT NULL DEFAULT 'ACTIVA', -- ACTIVA | ANULADA | INGRESADA
  fecha             TEXT NOT NULL,
  FOREIGN KEY (ci) REFERENCES compradores(ci),
  FOREIGN KEY (sector_id) REFERENCES sectores(id),
  FOREIGN KEY (ventanilla_codigo) REFERENCES ventanillas(codigo),
  UNIQUE (sector_id, puesto)              -- un puesto no puede venderse 2 veces
);

CREATE TABLE IF NOT EXISTS bloqueos (
  sector_id         INTEGER NOT NULL,
  puesto            TEXT NOT NULL,
  ventanilla_codigo TEXT NOT NULL,
  creado            TEXT NOT NULL,
  expira            TEXT NOT NULL,
  PRIMARY KEY (sector_id, puesto)
);

CREATE TABLE IF NOT EXISTS auditoria (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ventanilla_codigo TEXT,
  accion    TEXT NOT NULL,
  detalle   TEXT,
  fecha     TEXT NOT NULL
);
`);

// ---------------------------------------------------------------------------
// MIGRACIÓN: si la base de datos ya existía de una ejecución anterior
// (antes de agregar el panel de administración), le falta la columna
// "rol". La agregamos si no está, sin perder los datos ya cargados.
// ---------------------------------------------------------------------------
function columnaExiste(tabla, columna) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
}
if (!columnaExiste('ventanillas', 'rol')) {
  db.exec("ALTER TABLE ventanillas ADD COLUMN rol TEXT NOT NULL DEFAULT 'CAJERO'");
}

// ---------------------------------------------------------------------------
// SEED (datos iniciales) — sólo si la tabla sectores está vacía
// ---------------------------------------------------------------------------
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM sectores').get().n;
  if (count > 0) return;

  // 14 sectores según especificación (tarifario oficial del pliego).
  // Nota: el mapa oficial de la Alcaldía (afiche "Gestión 2026") maneja
  // tarifas individuales distintas para 1-8 + zonas turísticas; ambos
  // tarifarios quedan parametrizados aquí y son editables desde /api/sectores
  // (rol administrador) sin tocar código.
  const sectores = [
    { id: 1,  nombre: 'Sector 1',  tramo: 'Punto de partida – Zona El Reloj',              precio: 40, color: '#2e7d32' },
    { id: 2,  nombre: 'Sector 2',  tramo: 'Punto de partida – Zona El Reloj',              precio: 40, color: '#c9a227' },
    { id: 3,  nombre: 'Sector 3',  tramo: 'El Reloj – Calle Manuel Vilar',                 precio: 60, color: '#ffffff' },
    { id: 4,  nombre: 'Sector 4',  tramo: 'El Reloj – Calle Manuel Vilar',                 precio: 60, color: '#ff33cc' },
    { id: 5,  nombre: 'Sector 5',  tramo: 'Calle Manuel Vilar – Av. Kantuta',               precio: 70, color: '#1a237e' },
    { id: 6,  nombre: 'Sector 6',  tramo: 'Calle Manuel Vilar – Av. Kantuta',               precio: 70, color: '#6d4c26' },
    { id: 7,  nombre: 'Sector 7',  tramo: 'Av. Kantuta – Calle Ladislao Cabrera',           precio: 70, color: '#c62828' },
    { id: 8,  nombre: 'Sector 8',  tramo: 'Av. Kantuta – Calle Ladislao Cabrera',           precio: 70, color: '#ef6c00' },
    { id: 9,  nombre: 'Sector 9',  tramo: 'Ex Estación (TDJ) – Calle Tarapacá',             precio: 80, color: '#455a64' },
    { id: 10, nombre: 'Sector 10', tramo: 'Ex Estación (TDJ) – Calle Tarapacá',             precio: 80, color: '#607d8b' },
    { id: 11, nombre: 'Sector 11', tramo: 'Calle Tarapacá – Av. Aniceto Arce',              precio: 80, color: '#4527a0' },
    { id: 12, nombre: 'Sector 12', tramo: 'Calle Tarapacá – Av. Aniceto Arce',              precio: 80, color: '#7e57c2' },
    { id: 13, nombre: 'Sector 13', tramo: 'Av. Aniceto Arce – Plaza 25 de Mayo',            precio: 80, color: '#00838f' },
    { id: 14, nombre: 'Sector 14', tramo: 'Av. Aniceto Arce – Plaza 25 de Mayo',            precio: 80, color: '#26a69a' },
  ];
  const insSec = db.prepare(
    'INSERT INTO sectores (id, nombre, tramo, precio, color, cupos_totales) VALUES (?,?,?,?,?,?)'
  );
  for (const s of sectores) insSec.run(s.id, s.nombre, s.tramo, s.precio, s.color, 150);

  // Ventanillas de demostración (usuario/clave: cajero1 / 1234, etc.)
  const insVent = db.prepare(
    'INSERT INTO ventanillas (codigo, distrito, usuario, password_hash, sector_restringido, rol) VALUES (?,?,?,?,?,?)'
  );
  const demoVentanillas = [
    ['V-01', 'Distrito 1', 'cajero1', hashPassword('1234'), null, 'CAJERO'],
    ['V-02', 'Distrito 2', 'cajero2', hashPassword('1234'), null, 'CAJERO'],
    ['V-03', 'Distrito 3', 'cajero3', hashPassword('1234'), null, 'CAJERO'],
    // Cuenta de administración: no vende entradas, solo edita
    // sectores/precios/ventanillas y ve el dashboard de reportes.
    ['ADMIN', '—', 'admin', hashPassword('admin123'), null, 'ADMIN'],
  ];
  for (const v of demoVentanillas) insVent.run(...v);
}

// Si la base de datos ya existía de una corrida anterior y no tenía
// ningún usuario ADMIN (proyecto migrado), se crea uno automáticamente
// para no dejar el panel de administración inaccesible.
function asegurarAdmin() {
  const hayAdmin = db.prepare("SELECT 1 FROM ventanillas WHERE rol = 'ADMIN'").get();
  if (hayAdmin) return;
  const yaExisteUsuario = db.prepare("SELECT 1 FROM ventanillas WHERE usuario = 'admin'").get();
  if (yaExisteUsuario) {
    db.prepare("UPDATE ventanillas SET rol = 'ADMIN' WHERE usuario = 'admin'").run();
    return;
  }
  db.prepare(
    'INSERT INTO ventanillas (codigo, distrito, usuario, password_hash, sector_restringido, rol) VALUES (?,?,?,?,?,?)'
  ).run('ADMIN', '—', 'admin', hashPassword('admin123'), null, 'ADMIN');
}

function hashPassword(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

seed();
asegurarAdmin();

module.exports = { db, hashPassword };

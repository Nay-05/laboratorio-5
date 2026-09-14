'use strict';
/**
 * qrcode-nativo.js
 * -----------------------------------------------------------------------
 * Generador de código QR implementado desde cero, usando SOLO módulos
 * nativos de Node.js (no requiere `npm install` ni ningún paquete de
 * terceros). Implementa el estándar ISO/IEC 18004 "a mano":
 *
 *   1. Codificación de los datos en modo Byte (UTF-8).
 *   2. Corrección de errores Reed-Solomon sobre un cuerpo finito GF(256).
 *   3. Construcción de la matriz de módulos (buscadores, temporización,
 *      alineación, información de formato/versión).
 *   4. Aplicación de las 8 máscaras estándar y elección de la mejor según
 *      las 4 reglas de penalización del estándar.
 *   5. Exportación como SVG (texto plano, sin necesidad de librerías de
 *      dibujo ni de códecs de imagen) embebido en un data URL.
 *
 * Por qué existe este archivo: el proyecto pedía un QR que funcione
 * "sin depender de npm install" (por ejemplo, si en el aula el ejecutor
 * no tiene internet para bajar el paquete "qrcode"). Con este módulo el
 * QR se genera 100% localmente, con lo único que ya trae Node.js.
 *
 * Referencia usada para verificar la implementación: especificación
 * pública ISO/IEC 18004 (las tablas numéricas de capacidad y de bloques
 * de corrección de errores son datos del propio estándar, no código de
 * ningún tercero).
 * -----------------------------------------------------------------------
 */

// =========================================================================
// 1) TABLAS DEL ESTÁNDAR
// =========================================================================

// Codewords (bytes) TOTALES por versión (1 a 40). El índice 0 no se usa.
const CODEWORDS_TOTALES = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

// Por cada versión (fila) y nivel de corrección L,M,Q,H (columna):
// cantidad de bloques de corrección de errores.
const EC_BLOQUES = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4, 2, 4, 4, 4,
  2, 4, 6, 5, 2, 4, 6, 6, 2, 5, 8, 8, 4, 5, 8, 8, 4, 5, 8, 11, 4, 8, 10, 11,
  4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18, 6, 10, 17, 16, 6, 11, 16, 19,
  6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25, 8, 17, 23, 25, 9, 17, 23, 34,
  9, 18, 25, 30, 10, 20, 27, 32, 12, 21, 29, 35, 12, 23, 34, 37, 12, 25, 34, 40,
  13, 26, 35, 42, 14, 28, 38, 45, 15, 29, 40, 48, 16, 31, 43, 51, 17, 33, 45, 54,
  18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63, 20, 40, 56, 66, 21, 43, 59, 70,
  22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
];

// Codewords de corrección de errores TOTALES por versión/nivel (misma
// forma que la tabla anterior).
const EC_CODEWORDS = [
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64, 26, 48, 72, 88,
  36, 64, 96, 112, 40, 72, 108, 130, 48, 88, 132, 156, 60, 110, 160, 192, 72, 130, 192, 224,
  80, 150, 224, 264, 96, 176, 260, 308, 104, 198, 288, 352, 120, 216, 320, 384, 132, 240, 360, 432,
  144, 280, 408, 480, 168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700,
  224, 442, 644, 750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960, 312, 588, 870, 1050,
  336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260, 420, 784, 1140, 1350, 450, 812, 1200, 1440,
  480, 868, 1290, 1530, 510, 924, 1350, 1620, 540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064, 1590, 1890,
  600, 1120, 1680, 1980, 630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

// Nivel de corrección de errores: bit usado en la información de formato,
// e índice de columna dentro de EC_BLOQUES / EC_CODEWORDS ([L, M, Q, H]).
const NIVELES = {
  L: { bit: 1, idx: 0 },
  M: { bit: 0, idx: 1 },
  Q: { bit: 3, idx: 2 },
  H: { bit: 2, idx: 3 },
};

function totalCodewords(version) { return CODEWORDS_TOTALES[version]; }
function ecCodewordsTotal(version, nivel) { return EC_CODEWORDS[(version - 1) * 4 + nivel.idx]; }
function ecBloques(version, nivel) { return EC_BLOQUES[(version - 1) * 4 + nivel.idx]; }

// Modo Byte: 4 bits de indicador de modo (0100) + N bits de "cuántos
// caracteres siguen" (N depende del rango de versión).
const MODO_BYTE = 0b0100;
function bitsContadorCaracteres(version) { return version < 10 ? 8 : 16; }

// Capacidad máxima en bytes de datos (modo Byte) para una versión/nivel.
function capacidadBytes(version, nivel) {
  const dataCodewords = totalCodewords(version) - ecCodewordsTotal(version, nivel);
  const bitsUtiles = dataCodewords * 8 - (4 + bitsContadorCaracteres(version));
  return Math.floor(bitsUtiles / 8);
}

// Elige la versión (tamaño) más chica que alcanza para los datos dados.
function elegirVersion(longitudBytes, nivel) {
  for (let v = 1; v <= 40; v++) {
    if (longitudBytes <= capacidadBytes(v, nivel)) return v;
  }
  throw new Error('El texto es demasiado largo para un código QR (incluso en versión 40).');
}

// =========================================================================
// 2) CUERPO FINITO GF(256) Y CORRECCIÓN REED-SOLOMON
// =========================================================================
// El QR corrige errores de lectura (manchas, dobleces, mala impresión)
// gracias a codewords "extra" calculados con aritmética de Galois GF(256),
// usando el polinomio primitivo 0x11D que define el propio estándar.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function inicializarTablasGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // reducir módulo el polinomio primitivo
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Multiplicación de polinomios (arreglos de coeficientes) sobre GF(256).
function polyMul(p1, p2) {
  const out = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      out[i + j] ^= gfMul(p1[i], p2[j]);
    }
  }
  return out;
}

// Resto de dividir un polinomio de datos por el polinomio generador
// (esto es, en esencia, lo que da los codewords de corrección de errores).
function polyMod(dividendo, divisor) {
  let r = Uint8Array.from(dividendo);
  while (r.length - divisor.length >= 0) {
    const coef = r[0];
    for (let i = 0; i < divisor.length; i++) r[i] ^= gfMul(divisor[i], coef);
    let offset = 0;
    while (offset < r.length && r[offset] === 0) offset++;
    r = r.slice(offset);
  }
  return r;
}

// Genera el polinomio generador de grado "n" (uno por cada cantidad de
// codewords de corrección necesarios).
function generarPolinomioEC(grado) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < grado; i++) {
    poly = polyMul(poly, new Uint8Array([1, GF_EXP[i]]));
  }
  return poly;
}

function reedSolomonEncode(dataBytes, cantidadEC) {
  const genPoly = generarPolinomioEC(cantidadEC);
  const padded = new Uint8Array(dataBytes.length + cantidadEC);
  padded.set(dataBytes);
  const resto = polyMod(padded, genPoly);
  const salida = new Uint8Array(cantidadEC);
  salida.set(resto, cantidadEC - resto.length);
  return salida;
}

// =========================================================================
// 3) ARMADO DE LOS CODEWORDS FINALES (datos + relleno + EC intercalado)
// =========================================================================

// Buffer de bits simple: se van empujando bits y al final se agrupan en bytes.
class BufferDeBits {
  constructor() { this.bits = []; }
  push(valor, cantidadBits) {
    for (let i = cantidadBits - 1; i >= 0; i--) this.bits.push((valor >>> i) & 1);
  }
  get longitud() { return this.bits.length; }
  aBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
    }
    return bytes;
  }
}

function construirCodewords(textoUtf8Bytes, version, nivel) {
  const buffer = new BufferDeBits();

  // Encabezado del segmento: modo + cantidad de caracteres.
  buffer.push(MODO_BYTE, 4);
  buffer.push(textoUtf8Bytes.length, bitsContadorCaracteres(version));
  for (const byte of textoUtf8Bytes) buffer.push(byte, 8);

  const dataTotalCodewords = totalCodewords(version) - ecCodewordsTotal(version, nivel);
  const dataTotalBits = dataTotalCodewords * 8;

  // Terminador (hasta 4 ceros) + relleno hasta múltiplo de 8.
  if (buffer.longitud + 4 <= dataTotalBits) buffer.push(0, 4);
  while (buffer.longitud % 8 !== 0) buffer.push(0, 1);

  // Bytes de relleno alternando 0xEC / 0x11 (definidos por el estándar).
  const bytesFaltantes = (dataTotalBits - buffer.longitud) / 8;
  for (let i = 0; i < bytesFaltantes; i++) buffer.push(i % 2 ? 0x11 : 0xec, 8);

  const dataCodewords = buffer.aBytes();

  // --- División en bloques + corrección de errores por bloque ---
  const numBloques = ecBloques(version, nivel);
  const ecTotal = ecCodewordsTotal(version, nivel);
  const bloquesGrupo2 = totalCodewords(version) % numBloques;
  const bloquesGrupo1 = numBloques - bloquesGrupo2;
  const dataPorBloqueG1 = Math.floor(dataTotalCodewords / numBloques);
  const dataPorBloqueG2 = dataPorBloqueG1 + 1;

  const bloquesDatos = [];
  const bloquesEC = [];
  let offset = 0;
  for (let b = 0; b < numBloques; b++) {
    const tam = b < bloquesGrupo1 ? dataPorBloqueG1 : dataPorBloqueG2;
    const bloque = dataCodewords.slice(offset, offset + tam);
    bloquesDatos.push(bloque);
    bloquesEC.push(reedSolomonEncode(bloque, ecTotal / numBloques));
    offset += tam;
  }

  // --- Intercalado (interleaving): primero todos los datos, columna a
  // columna entre bloques, y al final todos los codewords de EC igual ---
  const maxDatos = Math.max(...bloquesDatos.map((b) => b.length));
  const salida = new Uint8Array(totalCodewords(version));
  let idx = 0;
  for (let i = 0; i < maxDatos; i++) {
    for (let b = 0; b < numBloques; b++) {
      if (i < bloquesDatos[b].length) salida[idx++] = bloquesDatos[b][i];
    }
  }
  const ecPorBloqueReal = bloquesEC[0].length;
  for (let i = 0; i < ecPorBloqueReal; i++) {
    for (let b = 0; b < numBloques; b++) salida[idx++] = bloquesEC[b][i];
  }
  return salida;
}

// =========================================================================
// 4) MATRIZ DE MÓDULOS (buscadores, temporización, alineación, datos...)
// =========================================================================

const PATRON_BUSCADOR = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
];
const PATRON_ALINEACION = [
  [1, 1, 1, 1, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 1, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 1, 1, 1, 1],
];

// Posiciones (centro) de los patrones de alineación para una versión dada.
// Fórmula equivalente a la tabla oficial del Anexo E de ISO/IEC 18004.
function posicionesAlineacion(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const cantidad = Math.floor(version / 7) + 2;
  const intervalo = size === 145 ? 26 : Math.ceil((size - 13) / (2 * cantidad - 2)) * 2;
  const posiciones = [size - 7];
  for (let i = 1; i < cantidad - 1; i++) posiciones[i] = posiciones[i - 1] - intervalo;
  posiciones.push(6);
  return posiciones.reverse();
}

class MatrizQR {
  constructor(size) {
    this.size = size;
    this.oscuro = Array.from({ length: size }, () => new Array(size).fill(false));
    this.reservado = Array.from({ length: size }, () => new Array(size).fill(false));
  }
  set(fila, col, oscuro, reservado) {
    if (fila < 0 || fila >= this.size || col < 0 || col >= this.size) return;
    this.oscuro[fila][col] = !!oscuro;
    if (reservado) this.reservado[fila][col] = true;
  }
  get(fila, col) { return this.oscuro[fila][col] ? 1 : 0; }
}

function dibujarBuscador(m, filaBase, colBase) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const fila = filaBase + r, col = colBase + c;
      if (fila < 0 || fila >= m.size || col < 0 || col >= m.size) continue;
      const dentro = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      m.set(fila, col, dentro ? PATRON_BUSCADOR[r][c] === 1 : false, true);
    }
  }
}

function dibujarAlineacion(m, filaCentro, colCentro) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      m.set(filaCentro + r, colCentro + c, PATRON_ALINEACION[r + 2][c + 2] === 1, true);
    }
  }
}

function dibujarTemporizacion(m) {
  for (let i = 8; i < m.size - 8; i++) {
    const oscuro = i % 2 === 0;
    m.set(6, i, oscuro, true);
    m.set(i, 6, oscuro, true);
  }
}

function gradoBit(n) {
  let g = 0;
  while (n !== 0) { g++; n >>>= 1; }
  return g;
}

// Información de formato: 5 bits de datos (nivel EC + máscara) protegidos
// con un código BCH(15,5) — así el lector puede recuperar nivel/máscara
// incluso si esos módulos se leyeron con algún error.
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G15_MASCARA = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const G15_GRADO = gradoBit(G15);
function infoFormato(nivelBit, patronMascara) {
  const datos = (nivelBit << 3) | patronMascara;
  let d = datos << 10;
  while (gradoBit(d) - G15_GRADO >= 0) d ^= (G15 << (gradoBit(d) - G15_GRADO));
  return ((datos << 10) | d) ^ G15_MASCARA;
}

// Información de versión (solo versiones 7 o más): BCH(18,6).
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
const G18_GRADO = gradoBit(G18);
function infoVersion(version) {
  let d = version << 12;
  while (gradoBit(d) - G18_GRADO >= 0) d ^= (G18 << (gradoBit(d) - G18_GRADO));
  return (version << 12) | d;
}

function dibujarInfoFormato(m, nivelBit, patronMascara) {
  const size = m.size;
  const bits = infoFormato(nivelBit, patronMascara);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    // vertical (franja junto al buscador top-left y hacia abajo)
    if (i < 6) m.set(i, 8, mod, true);
    else if (i < 8) m.set(i + 1, 8, mod, true);
    else m.set(size - 15 + i, 8, mod, true);
    // horizontal
    if (i < 8) m.set(8, size - i - 1, mod, true);
    else if (i < 9) m.set(8, 15 - i - 1 + 1, mod, true);
    else m.set(8, 15 - i - 1, mod, true);
  }
  m.set(size - 8, 8, true, true); // módulo fijo, siempre oscuro
}

function dibujarInfoVersion(m, version) {
  if (version < 7) return;
  const bits = infoVersion(version);
  const size = m.size;
  for (let i = 0; i < 18; i++) {
    const fila = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    const mod = ((bits >> i) & 1) === 1;
    m.set(fila, col, mod, true);
    m.set(col, fila, mod, true);
  }
}

// Coloca los codewords finales en zigzag, de abajo hacia arriba y de
// derecha a izquierda (saltando la columna de temporización), tal como
// exige el estándar.
function colocarDatos(m, codewords) {
  const size = m.size;
  let direccion = -1;
  let fila = size - 1;
  let bitIdx = 7;
  let byteIdx = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const colActual = col - c;
        if (!m.reservado[fila][colActual]) {
          let oscuro = false;
          if (byteIdx < codewords.length) {
            oscuro = ((codewords[byteIdx] >>> bitIdx) & 1) === 1;
          }
          m.set(fila, colActual, oscuro, false);
          bitIdx--;
          if (bitIdx === -1) { byteIdx++; bitIdx = 7; }
        }
      }
      fila += direccion;
      if (fila < 0 || fila >= size) {
        fila -= direccion;
        direccion = -direccion;
        break;
      }
    }
  }
}

// --- Las 8 máscaras estándar y las 4 reglas de penalización ---
function valorMascara(patron, fila, col) {
  switch (patron) {
    case 0: return (fila + col) % 2 === 0;
    case 1: return fila % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (fila + col) % 3 === 0;
    case 4: return (Math.floor(fila / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((fila * col) % 2) + ((fila * col) % 3) === 0;
    case 6: return (((fila * col) % 2) + ((fila * col) % 3)) % 2 === 0;
    case 7: return (((fila * col) % 3) + ((fila + col) % 2)) % 2 === 0;
    default: throw new Error('patrón de máscara inválido: ' + patron);
  }
}

function aplicarMascara(m, patron) {
  for (let f = 0; f < m.size; f++) {
    for (let c = 0; c < m.size; c++) {
      if (m.reservado[f][c]) continue;
      if (valorMascara(patron, f, c)) m.oscuro[f][c] = !m.oscuro[f][c];
    }
  }
}

function penalizacionN1(m) {
  const size = m.size;
  let puntos = 0;
  for (let fila = 0; fila < size; fila++) {
    let contCol = 0, contFila = 0, ultCol = null, ultFila = null;
    for (let col = 0; col < size; col++) {
      let mod = m.get(fila, col);
      if (mod === ultCol) contCol++; else { if (contCol >= 5) puntos += 3 + (contCol - 5); ultCol = mod; contCol = 1; }
      mod = m.get(col, fila);
      if (mod === ultFila) contFila++; else { if (contFila >= 5) puntos += 3 + (contFila - 5); ultFila = mod; contFila = 1; }
    }
    if (contCol >= 5) puntos += 3 + (contCol - 5);
    if (contFila >= 5) puntos += 3 + (contFila - 5);
  }
  return puntos;
}
function penalizacionN2(m) {
  let puntos = 0;
  for (let f = 0; f < m.size - 1; f++) {
    for (let c = 0; c < m.size - 1; c++) {
      const suma = m.get(f, c) + m.get(f, c + 1) + m.get(f + 1, c) + m.get(f + 1, c + 1);
      if (suma === 4 || suma === 0) puntos++;
    }
  }
  return puntos * 3;
}
function penalizacionN3(m) {
  const size = m.size;
  let puntos = 0;
  for (let fila = 0; fila < size; fila++) {
    let bitsCol = 0, bitsFila = 0;
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | m.get(fila, col);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) puntos++;
      bitsFila = ((bitsFila << 1) & 0x7ff) | m.get(col, fila);
      if (col >= 10 && (bitsFila === 0x5d0 || bitsFila === 0x05d)) puntos++;
    }
  }
  return puntos * 40;
}
function penalizacionN4(m) {
  let oscuros = 0;
  for (let f = 0; f < m.size; f++) for (let c = 0; c < m.size; c++) oscuros += m.get(f, c);
  const total = m.size * m.size;
  const k = Math.abs(Math.ceil((oscuros * 100 / total) / 5) - 10);
  return k * 10;
}

function elegirMejorMascara(m, nivelBit) {
  let mejorPatron = 0, mejorPenalizacion = Infinity;
  for (let p = 0; p < 8; p++) {
    dibujarInfoFormato(m, nivelBit, p); // reserva/placeholder (valores reales)
    aplicarMascara(m, p);
    const penal = penalizacionN1(m) + penalizacionN2(m) + penalizacionN3(m) + penalizacionN4(m);
    aplicarMascara(m, p); // deshacer (XOR es su propia inversa)
    if (penal < mejorPenalizacion) { mejorPenalizacion = penal; mejorPatron = p; }
  }
  return mejorPatron;
}

// =========================================================================
// 5) FUNCIÓN PRINCIPAL: texto -> matriz de módulos
// =========================================================================
function generarMatriz(texto, opciones) {
  const nivel = NIVELES[(opciones && opciones.nivel) || 'M'];
  const bytes = Buffer.from(String(texto), 'utf8');
  const version = elegirVersion(bytes.length, nivel);

  const codewords = construirCodewords(bytes, version, nivel);

  const size = version * 4 + 17;
  const m = new MatrizQR(size);

  dibujarBuscador(m, 0, 0);
  dibujarBuscador(m, 0, size - 7);
  dibujarBuscador(m, size - 7, 0);
  dibujarTemporizacion(m);
  for (const fila of posicionesAlineacion(version)) {
    for (const col of posicionesAlineacion(version)) {
      // Se omiten las posiciones que se solapan con los buscadores.
      const enBuscador = (fila <= 7 && col <= 7) || (fila <= 7 && col >= size - 8) || (fila >= size - 8 && col <= 7);
      if (!enBuscador) dibujarAlineacion(m, fila, col);
    }
  }
  dibujarInfoFormato(m, nivel.bit, 0); // reserva el área (valores reales al final)
  dibujarInfoVersion(m, version);
  colocarDatos(m, codewords);

  const patron = elegirMejorMascara(m, nivel.bit);
  aplicarMascara(m, patron);
  dibujarInfoFormato(m, nivel.bit, patron); // valores definitivos

  return { matriz: m.oscuro, size, version, nivel: (opciones && opciones.nivel) || 'M' };
}

// =========================================================================
// 6) RENDER A SVG (texto plano) + data URL — sin librerías de imagen
// =========================================================================
function aSVG(texto, opciones) {
  const { matriz, size } = generarMatriz(texto, opciones);
  const margen = (opciones && opciones.margen) !== undefined ? opciones.margen : 4;
  const dim = size + margen * 2;

  let path = '';
  for (let f = 0; f < size; f++) {
    for (let c = 0; c < size; c++) {
      if (matriz[f][c]) path += `M${c + margen},${f + margen}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  );
}

function aDataURL(texto, opciones) {
  const svg = aSVG(texto, opciones);
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

module.exports = { generarMatriz, aSVG, aDataURL };

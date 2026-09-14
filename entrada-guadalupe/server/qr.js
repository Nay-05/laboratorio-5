'use strict';
/**
 * qr.js
 * Genera la imagen QR (SVG embebido en un data URL) a partir del código
 * de validación del ticket.
 *
 * Antes este archivo dependía del paquete npm "qrcode" (había que correr
 * `npm install` para tener el QR gráfico). Ahora usa el generador propio
 * de `qrcode-nativo.js`, que implementa el estándar ISO/IEC 18004 con
 * módulos nativos de Node.js únicamente. Resultado: el QR funciona
 * siempre, incluso en una máquina sin internet y sin `npm install`.
 */

const qrNativo = require('./qrcode-nativo');

async function generarQRDataURL(texto) {
  try {
    // margen 4 = "zona de silencio" recomendada por el estándar, para que
    // los lectores de cámara enfoquen bien el código.
    return qrNativo.aDataURL(texto, { nivel: 'M', margen: 4 });
  } catch (e) {
    console.error('No se pudo generar el QR:', e.message);
    return null;
  }
}

// El generador propio no depende de ningún paquete externo, así que
// siempre está disponible. Se mantiene esta función para no romper el
// resto del código (server.js la usa para avisar si el QR está listo).
module.exports = { generarQRDataURL, disponible: () => true };

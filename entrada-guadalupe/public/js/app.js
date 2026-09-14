'use strict';

const API = '/api';
let TOKEN = localStorage.getItem('token') || null;
let SESION = JSON.parse(localStorage.getItem('sesion') || 'null');

let sectorSeleccionado = null;
let puestoBloqueado = null; // {sector_id, puesto}
let compradorValido = false;

// ---------------------------------------------------------------------------
// Helpers de red
// ---------------------------------------------------------------------------
async function api(method, pathname, body) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------
function mostrarVista() {
  const logueado = !!TOKEN;
  const esAdmin = logueado && SESION && SESION.rol === 'ADMIN';
  document.getElementById('viewLogin').classList.toggle('hidden', logueado);
  document.getElementById('viewVenta').classList.toggle('hidden', !logueado || esAdmin);
  document.getElementById('viewAdmin').classList.toggle('hidden', !logueado || !esAdmin);
  document.getElementById('sesionInfo').classList.toggle('hidden', !logueado);
  if (logueado && SESION) {
    document.getElementById('sesionTexto').textContent = esAdmin
      ? 'Administración'
      : `Ventanilla ${SESION.ventanilla} · ${SESION.distrito}`;
    if (esAdmin) {
      // Primero los sectores (llenan el <select> de sector restringido) y
      // recién después las ventanillas, que usan ese mismo <select>.
      cargarSectoresAdmin().then(cargarVentanillasAdmin);
    } else {
      cargarSectores();
    }
  }
}

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------
document.getElementById('btnLogin').addEventListener('click', async () => {
  const usuario = document.getElementById('loginUsuario').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  try {
    const data = await api('POST', '/auth/login', { usuario, password });
    TOKEN = data.token;
    SESION = { ventanilla: data.ventanilla, distrito: data.distrito, rol: data.rol };
    localStorage.setItem('token', TOKEN);
    localStorage.setItem('sesion', JSON.stringify(SESION));
    mostrarVista();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('btnLogout').addEventListener('click', async () => {
  try { await api('POST', '/auth/logout'); } catch (e) {}
  TOKEN = null; SESION = null;
  localStorage.removeItem('token'); localStorage.removeItem('sesion');
  mostrarVista();
});

// ---------------------------------------------------------------------------
// BÚSQUEDA POR C.I.
// ---------------------------------------------------------------------------
document.getElementById('btnBuscarCi').addEventListener('click', async () => {
  const ci = document.getElementById('ciInput').value.trim();
  const box = document.getElementById('ciResultado');
  compradorValido = false;
  actualizarBotonVenta();
  if (!ci) { box.textContent = 'Ingrese una cédula de identidad.'; return; }
  try {
    const data = await api('GET', `/compradores/${encodeURIComponent(ci)}`);
    if (data.comprador) document.getElementById('nombreInput').value = data.comprador.nombre;
    if (!data.puedeComprar) {
      box.innerHTML = `<span class="error">⛔ Esta C.I. ya registra ${data.cantidad}/${data.limite} entradas. No puede comprar más.</span>`;
      compradorValido = false;
    } else {
      box.innerHTML = `<span class="ok">✔ C.I. habilitada. Entradas ya compradas: ${data.cantidad}/${data.limite}.</span>`;
      compradorValido = true;
    }
  } catch (e) {
    box.innerHTML = `<span class="error">${e.message}</span>`;
  }
  actualizarBotonVenta();
});

// ---------------------------------------------------------------------------
// SECTORES
// ---------------------------------------------------------------------------
async function cargarSectores() {
  try {
    const sectores = await api('GET', '/sectores');
    const grid = document.getElementById('sectoresGrid');
    grid.innerHTML = '';
    sectores.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'sector-btn';
      btn.style.background = s.color;
      btn.style.color = esClaro(s.color) ? '#222' : '#fff';
      btn.disabled = s.disponibles <= 0;
      btn.innerHTML = `<b>${s.nombre}</b>${s.tramo}<br>Bs ${s.precio.toFixed(0)} · ${s.disponibles} disp.`;
      btn.addEventListener('click', () => seleccionarSector(s, btn));
      grid.appendChild(btn);
    });
  } catch (e) {
    console.error(e);
  }
}

function esClaro(hex) {
  const c = hex.replace('#', '');
  if (c.length < 6) return true;
  const r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 170;
}

function seleccionarSector(sector, btnEl) {
  sectorSeleccionado = sector;
  puestoBloqueado = null;
  document.querySelectorAll('.sector-btn').forEach((b) => b.classList.remove('selected'));
  btnEl.classList.add('selected');
  document.getElementById('puestoBox').classList.remove('hidden');
  document.getElementById('sectorSeleccionadoNombre').textContent = `${sector.nombre} (Bs ${sector.precio})`;
  document.getElementById('bloqueoEstado').textContent = '';
  document.getElementById('puestoInput').value = '';
  actualizarBotonVenta();
  actualizarResumen();
}

// ---------------------------------------------------------------------------
// BLOQUEO TEMPORAL (concurrencia)
// ---------------------------------------------------------------------------
document.getElementById('btnBloquear').addEventListener('click', async () => {
  const puesto = document.getElementById('puestoInput').value.trim();
  const estado = document.getElementById('bloqueoEstado');
  if (!sectorSeleccionado || !puesto) { estado.innerHTML = '<span class="error">Seleccione sector e indique el puesto.</span>'; return; }
  try {
    const data = await api('POST', '/bloqueos', { sector_id: sectorSeleccionado.id, puesto });
    puestoBloqueado = { sector_id: sectorSeleccionado.id, puesto };
    estado.innerHTML = `<span class="ok">✔ Puesto reservado hasta ${new Date(data.expira).toLocaleTimeString()} (${data.minutos} min).</span>`;
  } catch (e) {
    puestoBloqueado = null;
    estado.innerHTML = `<span class="error">${e.message}</span>`;
  }
  actualizarBotonVenta();
  actualizarResumen();
});

// ---------------------------------------------------------------------------
// RESUMEN / VENTA
// ---------------------------------------------------------------------------
function actualizarResumen() {
  const ci = document.getElementById('ciInput').value.trim();
  const nombre = document.getElementById('nombreInput').value.trim();
  const box = document.getElementById('resumenVenta');
  if (!sectorSeleccionado) { box.innerHTML = '<p class="hint">Seleccione sector y puesto.</p>'; return; }
  box.innerHTML = `
    <dl>
      <dt>Comprador</dt><dd>${nombre || '—'} (${ci || '—'})</dd>
      <dt>Sector</dt><dd>${sectorSeleccionado.nombre} — ${sectorSeleccionado.tramo}</dd>
      <dt>Puesto</dt><dd>${puestoBloqueado ? puestoBloqueado.puesto : '— (aún no reservado)'}</dd>
      <dt>Precio</dt><dd>Bs ${sectorSeleccionado.precio.toFixed(2)}</dd>
    </dl>`;
}

function checklistCompleto() {
  return document.getElementById('chkCedula').checked
    && document.getElementById('chkLuz').checked
    && document.getElementById('chkImpuestos').checked;
}

function actualizarBotonVenta() {
  const btn = document.getElementById('btnVender');
  const listo = compradorValido && sectorSeleccionado && puestoBloqueado && checklistCompleto()
    && document.getElementById('nombreInput').value.trim();
  btn.disabled = !listo;
}

['chkCedula', 'chkLuz', 'chkImpuestos'].forEach((id) =>
  document.getElementById(id).addEventListener('change', actualizarBotonVenta)
);
document.getElementById('nombreInput').addEventListener('input', () => { actualizarBotonVenta(); actualizarResumen(); });
document.getElementById('ciInput').addEventListener('input', actualizarResumen);

document.getElementById('btnVender').addEventListener('click', async () => {
  const errEl = document.getElementById('ventaError');
  errEl.classList.add('hidden');
  const ci = document.getElementById('ciInput').value.trim();
  const nombre = document.getElementById('nombreInput').value.trim();
  const telefono = document.getElementById('telefonoInput').value.trim();

  try {
    const venta = await api('POST', '/entradas', {
      ci, nombre, telefono,
      sector_id: sectorSeleccionado.id,
      puesto: puestoBloqueado.puesto,
      checklist: {
        cedula: document.getElementById('chkCedula').checked,
        facturaLuz: document.getElementById('chkLuz').checked,
        impuestos: document.getElementById('chkImpuestos').checked,
      },
    });
    await imprimirTicket(venta.id);
    resetFormulario();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

function resetFormulario() {
  document.getElementById('ciInput').value = '';
  document.getElementById('nombreInput').value = '';
  document.getElementById('telefonoInput').value = '';
  document.getElementById('ciResultado').textContent = '';
  ['chkCedula', 'chkLuz', 'chkImpuestos'].forEach((id) => (document.getElementById(id).checked = false));
  sectorSeleccionado = null; puestoBloqueado = null; compradorValido = false;
  document.getElementById('puestoBox').classList.add('hidden');
  actualizarResumen();
  actualizarBotonVenta();
  cargarSectores();
}

// ---------------------------------------------------------------------------
// IMPRESIÓN DE TICKET (formato térmico + QR)
// ---------------------------------------------------------------------------
async function imprimirTicket(entradaId) {
  const t = await api('GET', `/entradas/${entradaId}/ticket`);
  const win = window.open('', 'ticket', 'width=340,height=600');
  win.document.write(`
    <html><head><title>Ticket ${t.codigo_validacion}</title>
    <style>
      body{font-family:'Courier New',monospace;font-size:12px;margin:0;padding:10px;}
      h2{font-size:14px;text-align:center;margin:0 0 6px;}
      hr{border:none;border-top:1px dashed #999;margin:8px 0;}
      .qr{text-align:center;margin:10px 0;}
      .qr img{width:150px;height:150px;}
      .campo{display:flex;justify-content:space-between;}
      .codigo{text-align:center;font-weight:bold;letter-spacing:1px;}
    </style></head><body>
      <h2>ENTRADA VIRGEN DE GUADALUPE</h2>
      <div class="campo"><span>C.I.:</span><b>${t.ci}</b></div>
      <div class="campo"><span>Nombre:</span><b>${t.nombre}</b></div>
      <hr>
      <div class="campo"><span>Distrito:</span><b>${t.distrito}</b></div>
      <div class="campo"><span>Ventanilla:</span><b>${t.ventanilla}</b></div>
      <hr>
      <div class="campo"><span>Sector:</span><b>${t.sector}</b></div>
      <div class="campo"><span>Puesto:</span><b>${t.puesto}</b></div>
      <div class="campo"><span>Precio:</span><b>Bs ${t.precio.toFixed(2)}</b></div>
      <hr>
      <div class="qr">
        ${t.qr ? `<img src="${t.qr}">` : ''}
        <div class="codigo">${t.codigo_validacion}</div>
      </div>
      <hr>
      <p style="text-align:center;font-size:10px;">${new Date(t.fecha).toLocaleString()}</p>
      <script>window.print();<\/script>
    </body></html>
  `);
  win.document.close();
}

// ---------------------------------------------------------------------------
// PANEL DE ADMINISTRACIÓN (sectores, precios, ventanillas y dashboard)
// ---------------------------------------------------------------------------

// --- Pestañas ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'tabDashboard') cargarDashboard();
  });
});

// --- Sectores (editar nombre, tramo, precio, cupos, color, activo) ---
async function cargarSectoresAdmin() {
  try {
    const sectores = await api('GET', '/admin/sectores');
    renderTablaSectores(sectores);
    llenarSelectSectores(sectores);
  } catch (e) {
    document.getElementById('sectoresAdminMsg').innerHTML = `<span class="error">${e.message}</span>`;
  }
}

function renderTablaSectores(sectores) {
  const tbody = document.getElementById('tbodySectores');
  tbody.innerHTML = '';
  sectores.forEach((s) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-campo="nombre" value="${escapeHtml(s.nombre)}"></td>
      <td><input type="text" data-campo="tramo" value="${escapeHtml(s.tramo)}"></td>
      <td><input type="number" data-campo="precio" min="0" step="1" value="${s.precio}"></td>
      <td><input type="number" data-campo="cupos_totales" min="0" step="1" value="${s.cupos_totales}"></td>
      <td><input type="color" data-campo="color" value="${normalizarColor(s.color)}"></td>
      <td style="text-align:center"><input type="checkbox" data-campo="activo" ${s.activo ? 'checked' : ''}></td>
      <td><button class="btn btn-primary" data-guardar-sector="${s.id}">Guardar</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-guardar-sector]').forEach((btn) => {
    btn.addEventListener('click', () => guardarSector(btn.dataset.guardarSector, btn.closest('tr')));
  });
}

async function guardarSector(id, fila) {
  const msg = document.getElementById('sectoresAdminMsg');
  const cuerpo = {
    nombre: fila.querySelector('[data-campo=nombre]').value.trim(),
    tramo: fila.querySelector('[data-campo=tramo]').value.trim(),
    precio: Number(fila.querySelector('[data-campo=precio]').value),
    cupos_totales: Number(fila.querySelector('[data-campo=cupos_totales]').value),
    color: fila.querySelector('[data-campo=color]').value,
    activo: fila.querySelector('[data-campo=activo]').checked,
  };
  try {
    await api('PUT', `/admin/sectores/${id}`, cuerpo);
    msg.innerHTML = `<span class="ok">✔ Sector ${id} actualizado.</span>`;
    fila.classList.remove('fila-guardada');
    void fila.offsetWidth; // reinicia la animación si se guarda varias veces seguidas
    fila.classList.add('fila-guardada');
  } catch (e) {
    msg.innerHTML = `<span class="error">${e.message}</span>`;
  }
}

// --- Ventanillas (crear y editar cajeros) ---
async function cargarVentanillasAdmin() {
  try {
    const ventanillas = await api('GET', '/admin/ventanillas');
    renderTablaVentanillas(ventanillas);
  } catch (e) {
    document.getElementById('ventanillasAdminMsg').innerHTML = `<span class="error">${e.message}</span>`;
  }
}

function llenarSelectSectores(sectores) {
  ['nvSector'].forEach((selId) => {
    const sel = document.getElementById(selId);
    const actual = sel.value;
    sel.innerHTML = '<option value="">Todos</option>' +
      sectores.map((s) => `<option value="${s.id}">${escapeHtml(s.nombre)}</option>`).join('');
    sel.value = actual;
  });
}

function opcionesSectorSelect() {
  const sel = document.getElementById('nvSector');
  const opciones = Array.from(sel.options).map((o) => o.outerHTML).join('');
  return opciones || '<option value="">Todos</option>';
}

function renderTablaVentanillas(ventanillas) {
  const tbody = document.getElementById('tbodyVentanillas');
  tbody.innerHTML = '';
  ventanillas.forEach((v) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(v.codigo)}</td>
      <td><input type="text" data-campo="distrito" value="${escapeHtml(v.distrito)}"></td>
      <td>${escapeHtml(v.usuario)}</td>
      <td><select data-campo="sector_restringido">${opcionesSectorSelect()}</select></td>
      <td>
        <select data-campo="rol">
          <option value="CAJERO">Cajero</option>
          <option value="ADMIN">Administrador</option>
        </select>
      </td>
      <td style="text-align:center"><input type="checkbox" data-campo="activo" ${v.activo ? 'checked' : ''}></td>
      <td><input type="text" data-campo="password" placeholder="(sin cambios)"></td>
      <td><button class="btn btn-primary" data-guardar-ventanilla="${v.codigo}">Guardar</button></td>
    `;
    tr.querySelector('[data-campo=sector_restringido]').value = v.sector_restringido || '';
    tr.querySelector('[data-campo=rol]').value = v.rol;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-guardar-ventanilla]').forEach((btn) => {
    btn.addEventListener('click', () => guardarVentanilla(btn.dataset.guardarVentanilla, btn.closest('tr')));
  });
}

async function guardarVentanilla(codigo, fila) {
  const msg = document.getElementById('ventanillasAdminMsg');
  const password = fila.querySelector('[data-campo=password]').value.trim();
  const cuerpo = {
    distrito: fila.querySelector('[data-campo=distrito]').value.trim(),
    sector_restringido: fila.querySelector('[data-campo=sector_restringido]').value || null,
    rol: fila.querySelector('[data-campo=rol]').value,
    activo: fila.querySelector('[data-campo=activo]').checked,
  };
  if (password) cuerpo.password = password;
  try {
    await api('PUT', `/admin/ventanillas/${codigo}`, cuerpo);
    msg.innerHTML = `<span class="ok">✔ Ventanilla ${codigo} actualizada.</span>`;
    fila.querySelector('[data-campo=password]').value = '';
    fila.classList.remove('fila-guardada');
    void fila.offsetWidth;
    fila.classList.add('fila-guardada');
  } catch (e) {
    msg.innerHTML = `<span class="error">${e.message}</span>`;
  }
}

document.getElementById('btnCrearVentanilla').addEventListener('click', async () => {
  const msg = document.getElementById('ventanillasAdminMsg');
  const cuerpo = {
    codigo: document.getElementById('nvCodigo').value.trim(),
    distrito: document.getElementById('nvDistrito').value.trim(),
    usuario: document.getElementById('nvUsuario').value.trim(),
    password: document.getElementById('nvPassword').value.trim(),
    sector_restringido: document.getElementById('nvSector').value || null,
    rol: document.getElementById('nvRol').value,
  };
  if (!cuerpo.codigo || !cuerpo.distrito || !cuerpo.usuario || !cuerpo.password) {
    msg.innerHTML = '<span class="error">Complete código, distrito, usuario y contraseña.</span>';
    return;
  }
  try {
    await api('POST', '/admin/ventanillas', cuerpo);
    msg.innerHTML = `<span class="ok">✔ Ventanilla ${cuerpo.codigo} creada.</span>`;
    ['nvCodigo', 'nvDistrito', 'nvUsuario', 'nvPassword'].forEach((id) => (document.getElementById(id).value = ''));
    cargarVentanillasAdmin();
  } catch (e) {
    msg.innerHTML = `<span class="error">${e.message}</span>`;
  }
});

// --- Dashboard de ventas (sector y ventanilla) ---
document.getElementById('btnRefrescarDash').addEventListener('click', cargarDashboard);

async function cargarDashboard() {
  try {
    const data = await api('GET', '/reportes/resumen');
    renderDashboard(data);
  } catch (e) {
    document.getElementById('dashTotales').innerHTML = `<span class="error">${e.message}</span>`;
  }
}

function renderDashboard(data) {
  const { porSector, porVentanilla, totales, ingresadas } = data;

  document.getElementById('dashTotales').innerHTML = `
    <div class="dash-card"><span class="valor">${totales.entradas}</span><span class="etiqueta">Entradas vendidas</span></div>
    <div class="dash-card"><span class="valor">Bs ${totales.recaudado.toFixed(0)}</span><span class="etiqueta">Total recaudado</span></div>
    <div class="dash-card"><span class="valor">${ingresadas}</span><span class="etiqueta">Ya ingresaron (QR validado)</span></div>
  `;

  const maxRecaudadoSector = Math.max(1, ...porSector.map((s) => s.recaudado));
  document.getElementById('chartSector').innerHTML = porSector.map((s) => `
    <div class="chart-bar-row">
      <span>${escapeHtml(s.nombre)}</span>
      <div class="chart-bar-track">
        <div class="chart-bar-fill" style="width:${(s.recaudado / maxRecaudadoSector * 100).toFixed(1)}%;background:${s.id % 2 ? '#8c2f2f' : '#b8860b'}"></div>
      </div>
      <span class="chart-bar-valor">${s.vendidos} · Bs ${s.recaudado.toFixed(0)}</span>
    </div>
  `).join('') || '<p class="hint">Todavía no hay ventas registradas.</p>';

  const maxRecaudadoVent = Math.max(1, ...porVentanilla.map((v) => v.recaudado));
  document.getElementById('chartVentanilla').innerHTML = porVentanilla.map((v) => `
    <div class="chart-bar-row">
      <span>${escapeHtml(v.codigo)} · ${escapeHtml(v.distrito)}</span>
      <div class="chart-bar-track">
        <div class="chart-bar-fill" style="width:${(v.recaudado / maxRecaudadoVent * 100).toFixed(1)}%;background:#2e7d32"></div>
      </div>
      <span class="chart-bar-valor">${v.vendidos} · Bs ${v.recaudado.toFixed(0)}</span>
    </div>
  `).join('') || '<p class="hint">Todavía no hay ventas registradas.</p>';
}

// --- Utilidades ---
function escapeHtml(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function normalizarColor(hex) {
  // <input type="color"> exige "#rrggbb" exacto (sin nombres ni formatos cortos).
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  return '#cccccc';
}

// ---------------------------------------------------------------------------
mostrarVista();

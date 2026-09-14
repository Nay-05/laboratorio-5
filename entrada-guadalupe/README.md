# Sistema de Venta de Entradas — Entrada de la Virgen de Guadalupe

Aplicación web centralizada para la venta controlada de entradas en las
ventanillas autorizadas, cumpliendo los criterios de **democratización**
(máx. 2 entradas por persona), **segmentación** (14 sectores con tarifario
propio), **descarte** (bloqueo temporal para evitar sobreventa) y
**fidelización** (registro histórico del comprador por C.I.).

Stack: **Node.js** (backend/API + servidor web) + **Java** (cliente de
escritorio alternativo para las ventanillas) + **SQLite** (base de datos).

---

## 1. Arquitectura

```
entrada-guadalupe/
├── server/              → Backend Node.js (API REST + reglas de negocio)
│   ├── server.js         → Rutas HTTP, autenticación, concurrencia, ventas
│   ├── db.js              → Esquema y siembra de la base de datos (SQLite)
│   └── qr.js               → Generación del código QR del ticket
├── public/               → Frontend web (lo que ve el cajero en el navegador)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── java-client/          → Cliente de escritorio alternativo (Java/Swing)
│   └── src/Main.java       → Consume la MISMA API REST que la web
├── database/
│   ├── schema.sql          → Esquema de referencia
│   └── entradas.db          → Base de datos física (se genera sola al arrancar)
├── docs/screenshots/      → Capturas de las interfaces principales
└── package.json
```

**¿Por qué Node.js *y* Java?** El servidor central (Node.js) expone una
única API REST que es la fuente de verdad del inventario y las reglas de
negocio. Sobre esa misma API se construyeron **dos clientes** para las
ventanillas: la interfaz web (HTML/JS, la aplicación principal pedida en el
punto 1 del pliego) y un cliente de escritorio en **Java Swing** para
ventanillas que prefieran una aplicación instalable. Ambos comparten el
mismo inventario en tiempo real porque hablan con el mismo backend.

### Por qué SQLite embebido (`node:sqlite`)
Se usó el motor SQLite **nativo de Node.js 22** (sin dependencias externas)
para que el proyecto arranque con `npm start` sin necesidad de instalar ni
configurar un servidor de base de datos aparte. Es igualmente válido
migrarlo a PostgreSQL/MySQL para un despliegue Cloud multi-servidor; el
único archivo que cambiaría es `server/db.js`.

---

## 2. Requisitos

- **Node.js 22 o superior** (incluye `node:sqlite`, no requiere instalar
  motor de base de datos aparte).
- **JDK 17+** (`javac`/`java`) solo si se va a compilar el cliente de
  escritorio en Java. *(Este entorno de generación del proyecto sólo tenía
  el JRE, por lo que el cliente Java fue revisado y probado en cuanto a
  sintaxis pero no compilado aquí; compílelo con el JDK completo en su
  máquina/laboratorio.)*

## 3. Instalación y ejecución

```bash
cd entrada-guadalupe
npm install        # instala el paquete "qrcode" para el QR gráfico del ticket
npm start          # equivalente a: node server/server.js
```

Abrir en el navegador: **http://localhost:3000**

> El servidor funciona igual sin `npm install` (usa sólo módulos nativos de
> Node), pero el ticket mostrará el código de validación en texto en vez del
> QR gráfico hasta que se instale el paquete `qrcode`.

**Usuarios de ventanilla de demostración** (usuario / contraseña):
| Usuario | Ventanilla | Distrito |
|---|---|---|
| cajero1 | V-01 | Distrito 1 |
| cajero2 | V-02 | Distrito 2 |
| cajero3 | V-03 | Distrito 3 |

### Cliente de escritorio en Java

```bash
cd java-client
javac -d out src/Main.java
java -cp out Main http://localhost:3000
```

Abre una ventana Swing con el mismo flujo de venta (login → CI → sector/puesto
→ checklist → venta), consumiendo la API del servidor Node.js.

---

## 4. Cumplimiento de la especificación

### 4.1 Arquitectura y módulo web
- Aplicación web centralizada accesible por navegador (`public/`), servida
  por el mismo proceso Node.js (`server/server.js`), apta para Cloud u
  On-Premise.
- **Control de concurrencia**: `POST /api/bloqueos` crea un bloqueo
  temporal de 5 minutos (`LOCK_MINUTOS` en `server.js`) sobre
  `(sector_id, puesto)`. Mientras el bloqueo esté vigente, ninguna otra
  ventanilla puede reservar ni vender ese mismo puesto (probado en la
  sección 5). Un `setInterval` limpia bloqueos expirados cada 30s.
- **Asignación de sectores**: cada ventanilla puede tener un
  `sector_restringido` en la tabla `ventanillas` (venta limitada a un
  sector/distrito) o quedar en `NULL` para vender cualquier sector, con
  inventario unificado y sincronizado en tiempo real (`disponibles` se
  recalcula en cada `GET /api/sectores`).

### 4.2 Validación de requisitos y compradores
- `GET /api/compradores/:ci` busca por cédula **antes** de habilitar la
  selección de asiento y devuelve cuántas entradas activas tiene esa C.I.
- **Límite global de 2 entradas por C.I.**: se valida contando entradas con
  `estado != 'ANULADA'` en toda la base (no sólo en la ventanilla actual),
  al momento de crear la venta (`POST /api/entradas`), rechazando con
  HTTP 409 si ya llegó al límite.
- **Checklist de documentación obligatoria** (Cédula original, Factura de
  Luz, Comprobante de Impuestos del Inmueble): el backend **rechaza** la
  venta (HTTP 400) si falta marcar cualquiera de los tres, sin confiar
  únicamente en la validación del frontend.

### 4.3 Sectores y tarifario
Los 14 sectores y precios del pliego se parametrizan en `server/db.js`
(tabla `sectores`), editables sin tocar el código de negocio. El afiche
oficial de la Alcaldía ("Gestión 2026") adjuntado en la conversación
maneja un tarifario alternativo por sector individual (1 al 8, más zonas
turísticas); como ambos documentos difieren, el sistema deja el precio
**por sector** completamente parametrizable — basta actualizar la tabla
`sectores` (o exponer un panel de administración sobre
`GET/PUT /api/sectores`) para reflejar el tarifario vigente que confirme
la Alcaldía.

### 4.4 Venta, impresión y reportes
- `POST /api/entradas` registra la venta y genera un `codigo_validacion`
  único (ej. `GDL-4-M-112-89486FF9`).
- `GET /api/entradas/:id/ticket` arma el comprobante con C.I., nombre,
  distrito, ventanilla, sector, puesto y el QR (imagen PNG en base64) del
  código de validación.
- El botón **"Registrar venta e imprimir"** abre una ventana con formato
  de 280px (ancho estándar de impresora térmica de 80mm) y dispara
  `window.print()` automáticamente.
- `POST /api/validar` permite, en el control de ingreso, escanear/pegar el
  código del QR: valida que exista, que no esté anulado y que no haya sido
  usado antes, y lo marca como `INGRESADA`.
- `GET /api/reportes/resumen` devuelve entradas vendidas y recaudación por
  sector y total general.

---

## 5. Pruebas de las reglas de negocio (realizadas sobre este proyecto)

```
✔ Venta normal con checklist completo               → 201 Created
✔ 3ra entrada para la misma C.I.                     → 409 "ya alcanzó el límite de 2 entradas"
✔ Venta de un puesto ya vendido                      → 409 "Ese puesto ya fue vendido"
✔ Venta con checklist incompleto (falta factura luz) → 400 "Falta validar documentación obligatoria"
✔ Dos ventanillas reservando el mismo puesto a la vez → la 2da recibe 409
                                                         "reservado temporalmente por otra ventanilla"
```

---

## 6. Entregables (según punto 5 del pliego)

1. **La aplicación ejecutable** → `npm install && npm start` (Node.js) +
   cliente Java opcional en `java-client/`.
2. **La base de datos** → `database/entradas.db` (SQLite, se genera y siembra
   sola) + `database/schema.sql` de referencia.
3. **Screenshots de las interfaces principales** → `docs/screenshots/`
   (login, pantalla de venta con sectores/checklist, ticket con QR).
4. **Demostración en el aula** → seguir el flujo de la sección 7.

---

## 7. Guion sugerido para la demostración en aula

1. Mostrar `npm start` levantando el servidor y la base de datos vacía.
2. Iniciar sesión como `cajero1`.
3. Buscar una C.I. nueva → mostrar que habilita la compra (0/2).
4. Marcar el checklist, elegir un sector, reservar un puesto (mostrar que
   queda "bloqueado" 5 minutos) y registrar la venta → se abre e imprime el
   ticket con el QR.
5. Repetir la venta con la **misma C.I.** una vez más (2/2) y demostrar que
   al 3er intento el sistema la **rechaza automáticamente**.
6. Abrir dos pestañas con dos cajeros distintos e intentar reservar el
   **mismo puesto** desde ambas → la segunda es rechazada (control de
   concurrencia).
7. Mostrar `GET /api/reportes/resumen` (o un panel simple) con lo vendido
   y recaudado por sector.

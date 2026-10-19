# Feedly Local · WebGPU Edition

Lector de feeds RSS/Atom y alertas de búsqueda de ejecución 100 % local, rápido y privado, inspirado en la vista de revista de **Feedly**. Construido **sin dependencias externas (`0` paquetes en `node_modules`)** sobre la API nativa de **Node.js (v22.5+)**, motor de búsqueda de texto completo **SQLite FTS5** y un pipeline visual acelerado por GPU mediante **WebGPU + WGSL** (con respaldo automático en Canvas 2D).

Repositorio oficial: [https://github.com/0utKast/feedly-local-webgpu](https://github.com/0utKast/feedly-local-webgpu)

---

## Características principales

* **Diseño Magazine en Rejilla de 3 Tarjetas:** Vista editorial limpia con modo claro y modo oscuro, cabeceras panorámicas `16:9` y tipografía optimizada para lectura rápida.
* **Procesado Visual con WebGPU y Shaders WGSL:** Corrección de color perceptual, viñeteado suave, micro-contraste y zoom dinámico acelerado por hardware en cada tarjeta (con *fallback* transparente a Canvas 2D si el navegador no soporta WebGPU).
* **Sincronización Automática en Segundo Plano (Estilo Feedly):**
  * Demonio integrado que actualiza las fuentes automáticamente cada **15 minutos** sin intervención manual.
  * Ordenación cronológica estricta de **más reciente a más antigua** (`published_ts DESC`) y deduplicación global entre fuentes.
  * Refresco silencioso en vivo de las pestañas abiertas cuando llegan noticias nuevas.
* **Gestión Inteligente de Lectura:**
  * **Auto-lectura al hacer scroll** (activable/desactivable desde la barra superior).
  * **Menú desplegable «✓ Marcar como leídas ▾» idéntico a Feedly** con tres alcances y contadores en vivo:
    1. *Todas las noticias de la vista actual*
    2. *Noticias con más de 24 horas*
    3. *Noticias con más de una semana*
  * **Botón Deshacer (`Undo`)** para restaurar lotes de noticias marcadas como leídas por error.
  * **Paginación automática (Scroll infinito)** para recorrer carpetas con cientos o miles de noticias sin cortes.
* **Guardado Protegido y Notas Personales:** Las noticias guardadas («Guardar / Proteger») o aquellas a las que añadas una nota personal quedan blindadas frente al borrado automático al marcar como leídas.
* **Alertas de Búsqueda Integradas (Sin clave API):** Crea fuentes dinámicas por palabras clave igual que en Feedly Pro conectando directamente con:
  * **Google News** (Español e Internacional)
  * **Reddit** (Subreddits directos o búsqueda booleana)
  * **Hacker News**
* **Motor Inteligente de Imágenes y Lector de Texto Completo:** Si un feed RSS no incluye miniatura, el servidor extrae la imagen `og:image` original o asigna una fotografía periodística contextual única, además de permitir extraer el texto completo del artículo sin salir de la aplicación.
* **Catálogo Inicial Curado (`feedly-organizado.opml`):** En el primer arranque importa automáticamente **196 fuentes organizadas en 8 carpetas**, con cobertura exhaustiva de **IA Generativa y Grandes Modelos**, **Modelos Abiertos e IA Local (Ollama, llama.cpp, vLLM, Hugging Face, r/LocalLLaMA)**, **Herramientas IA, Agentes y MCP**, **C++ y Desarrollo**, **Linux y Open Source**, **Actualidad Tecnológica** y **Ciencia**.

---

## Requisitos previos

* **Node.js v22.5.0 o superior** (incluye de serie el módulo nativo `node:sqlite` con soporte FTS5).
  * Puedes descargarlo desde [https://nodejs.org/](https://nodejs.org/).
* **No requiere `npm install`** ni compiladores adicionales en ningún sistema operativo.

---

## Instalación y uso multiplataforma (macOS, Windows y Linux)

### 1. Clonar el repositorio

```bash
git clone https://github.com/0utKast/feedly-local-webgpu.git
cd feedly-local-webgpu
```

### 2. Iniciar la aplicación

Puedes arrancarla desde cualquier terminal en los tres sistemas operativos con:

```bash
npm start
```

O bien utilizando los **lanzadores directos por sistema operativo** incluidos en la raíz del proyecto (inician el servidor en el puerto `3040` y abren automáticamente `http://localhost:3040` en tu navegador):

* **macOS:** Haz doble clic en `iniciar-mac.command` (o ejecuta `./iniciar-mac.command`).
* **Windows:** Haz doble clic en `iniciar-windows.bat`.
* **Linux:** Ejecuta `./iniciar-linux.sh`.

Una vez iniciado, abre en tu navegador:
**[http://localhost:3040](http://localhost:3040)**

---

## Ejecución mediante Docker (Opcional)

Si prefieres ejecutarlo en un contenedor aislado en Linux, Windows, macOS o un servidor doméstico / NAS:

```bash
docker compose up -d
```

Los datos persistentes (tu base de datos SQLite, noticias guardadas y notas personales) se almacenarán automáticamente en la carpeta local `./data`.

---

## Estructura del proyecto

```text
feedly-local-webgpu/
├── server.js                # Servidor HTTP nativo, motor RSS/Atom, SQLite FTS5 y auto-sync
├── package.json             # Configuración para Node.js >= 22.5.0 (0 dependencias externas)
├── feedly-organizado.opml   # Suscripciones iniciales organizadas por carpetas (auto-importable)
├── iniciar-mac.command      # Lanzador rápido para macOS
├── iniciar-windows.bat      # Lanzador rápido para Windows
├── iniciar-linux.sh         # Lanzador rápido para Linux
├── Dockerfile               # Imagen Docker ligera basada en node:22-alpine
├── docker-compose.yml       # Orquestación Docker con volumen persistente ./data
└── public/
    ├── index.html           # Interfaz principal, lector lateral y modales de gestión
    ├── styles.css           # Sistema de diseño Magazine 3-columnas (Modo Claro / Oscuro)
    └── app.js               # Cliente reactivo, pipeline WebGPU/WGSL y controles de lectura
```

---

## Licencia

Publicado bajo licencia MIT. Libre para uso personal, educativo y modificación.

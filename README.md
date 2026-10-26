# Feedly Local · WebGPU & Local AI Edition

Lector de feeds **RSS/Atom**, alertas de búsqueda y **Agente de Inteligencia Ejecutiva en Vivo** de ejecución **100 % Local-First**, rápido y privado, inspirado en la vista de revista de **Feedly**.

Construido **sin dependencias externas (`0` paquetes en `node_modules`)** sobre la API nativa de **Node.js (v22.5+)**, motor de búsqueda indexada **SQLite FTS5**, síntesis neuronal local mediante **Ollama (`Gemma 4`)** y un doble pipeline en GPU acelerado mediante **WebGPU + Shaders WGSL** (tanto de **cómputo paralelo `@compute`** como de **renderizado `@vertex` / `@fragment`**).

Repositorio oficial: **[https://github.com/0utKast/feedly-local-webgpu](https://github.com/0utKast/feedly-local-webgpu)**

---

## 🎯 Por qué una arquitectura 100 % Local-First

Cuando se monitorizan cerca de **200 fuentes activas** (generando entre 500 y 1.500 noticias diarias), depender de APIs en la nube para clasificar, traducir y resumir la información presenta costes impredecibles por consumo de tokens, límites de cuota y pérdida de privacidad sobre los hábitos de lectura.

Este proyecto demuestra cómo combinar tres tecnologías modernas directamente en la máquina del usuario sin pagar suscripciones ni enviar un solo byte a servidores de terceros:

1. **Almacenamiento e Indexación Nativa (`node:sqlite` + FTS5 en modo WAL):** Consultas instantáneas sobre miles de artículos e historial temporal de 72 horas sin instalar motores de base de datos externos.
2. **Cómputo y Gráficos en el Navegador (`WebGPU` + `WGSL`):** Uso directo de la GPU desde JavaScript mediante *Compute Shaders* (`vec4<f32>` SIMD) para calcular matrices de afinidad temática entre clústeres de noticias en menos de `2 ms`, junto con *Fragment Shaders* para el mapa de calor interactivo y el procesado fotográfico de cada tarjeta.
3. **Inteligencia Artificial Local (`Ollama` + `Gemma 4`):** Un agente residente que agrupa eventos multi-fuente, extrae el cuerpo completo de las noticias principales (*Deep Read*), traduce automáticamente titulares del inglés al español con caché persistente y redacta boletines ejecutivos cada hora en segundo plano.

---

## ✨ Características Principales

### 1. ✦ Agente de «Informes en Vivo» y Monitoreo Horario (IA Local + WebGPU)
Accesible desde el botón superior **✦ Informes en Vivo**, ofrece un centro de inteligencia periodística pre-calculado de forma continua:
* **4 Ventanas de Análisis Pre-elaboradas:**
  * **Actuales (No leídas):** Analiza únicamente las noticias pendientes de leer en ese instante.
  * **Última hora (`1h`), Últimas 12 horas (`12h`) y Últimas 24 horas (`24h`):** Elaboradas sobre el registro histórico (`articles_history`), manteniendo la memoria de lo ocurrido aunque ya hayas marcado las noticias como leídas.
* **Jerarquía Editorial Clara (Noticia → Resumen → Medios):**
  * Destaca en cabecera la **★ Noticia Estrella del Momento** (el suceso con mayor convergencia de medios independientes y peso informativo), mostrando en primer lugar el **título en español**, a continuación su **descripción corta con cifras y hechos clave**, y finalmente los **medios en los que ha aparecido**.
  * Genera automáticamente las secciones **🔥 Grandes Temas en Tendencia** y **📂 Lo Más Destacado por Áreas Técnicas**.
* **Clustering Bilingüe de Eventos (`TF-IDF` + Fusión Inter-idioma):** Agrupa noticias sobre un mismo hecho concreto aunque provengan de medios en español e inglés, separando eventos distintos de una misma compañía (por ejemplo, distinguiendo una salida a bolsa de una demanda judicial o un incidente de seguridad).
* **Traducción Automática al Español con Caché SQLite:** Todos los titulares y subtítulos en inglés de la columna derecha de clústeres se traducen automáticamente al español mediante **Gemma 4** y quedan almacenados en la tabla `translations_cache` para visualización inmediata.
* **Espectro de Impacto y Afinidad Semántica (WebGPU):**
  * Un *Compute Shader* WGSL (`@compute @workgroup_size(64)`) calcula en la GPU la similitud coseno entre los vectores característicos de los grandes temas.
  * Un *Render Shader* WGSL dibuja en tiempo real un mapa de calor con burbujas proporcionales al volumen de cobertura, anillos multi-fuente y resaltado interactivo al pasar el cursor sobre cada clúster.
* **Triaje por Clúster en 1 Clic:** Cada tema agrupado incluye el botón `✓ Marcar X leídas` para dar por leído y retirar de la bandeja un suceso completo (aparecido en 10, 20 o 30 medios) de una sola vez.

### 2. 📰 Vista Magazine en Rejilla de 3 Tarjetas con Pipeline Visual WebGPU
* Diseño editorial limpio con **Modo Claro** y **Modo Oscuro**, cabeceras panorámicas `16:9` y tipografía optimizada para lectura ágil.
* **Procesado Fotográfico por GPU (`WebGpuCardProcessor`):** Cada miniatura pasa por un shader WGSL que aplica corrección de color perceptual, micro-contraste, viñeteado suave y zoom dinámico acelerado por hardware (con *fallback* transparente a Canvas 2D si el navegador no dispone de WebGPU).

### 3. 🔄 Sincronización Automática y Gestión Inteligente de Lectura
* **`Daemon` (servicio de sincronización en segundo plano) cada 15 minutos:** Actualiza los feeds automáticamente, deduplica artículos por URL/título normalizado y refresca silenciosamente la interfaz abierta.
* **Auto-lectura al hacer Scroll:** Marca como leídas y retira las fichas que ya has superado al desplazarte hacia abajo (activable/desactivable desde la barra superior).
* **Menú Desplegable «✓ Marcar como leídas ▾» idéntico a Feedly:**
  1. *Todas las noticias de la vista actual*
  2. *Noticias con más de 24 horas*
  3. *Noticias con más de una semana*
* **Botón Deshacer (`Undo`):** Restaura al instante el último lote de artículos marcados como leídos por error.
* **Guardado Protegido y Notas Personales:** Los artículos marcados con **Guardar / Proteger** o aquellos con notas de investigación del usuario quedan blindados frente al borrado automático.

### 4. 🔍 Alertas de Búsqueda Sin Clave API y Lector de Texto Completo
* Crea fuentes dinámicas por palabras clave igual que en *Feedly Pro* conectando directamente con **Google News** (Español e Internacional), **Reddit** y **Hacker News**.
* **Lector Lateral Inmersivo:** Extrae el artículo completo de la web original bajo demanda y busca automáticamente imágenes `og:image` de alta resolución cuando un feed RSS no incluye fotografía.
* **Catálogo Inicial Curado (`feedly-organizado.opml`):** Incluye de serie **196 fuentes organizadas en 8 carpetas** (*IA Generativa y Grandes Modelos*, *Modelos Abiertos e IA Local*, *Herramientas IA, Agentes y MCP*, *C++ y Desarrollo*, *Linux y Open Source*, *Actualidad Tecnológica* y *Ciencia*).

---

## 🛠️ Herramientas y Arquitectura Técnica

| Capa | Tecnología / Herramienta | Función en el Proyecto |
| :--- | :--- | :--- |
| **Runtime y Servidor HTTP** | **Node.js (v22.5+)** (`node:http`, `node:zlib`, `node:crypto`) | Servidor web asíncrono, parser RSS/Atom/RDF tolerante a fallos, extractor HTML y proxy CORS de imágenes con **0 dependencias en `package.json`**. |
| **Base de Datos Embebida** | **SQLite Nativo (`node:sqlite`) + `FTS5` (Modo `WAL`)** | Persistencia transaccional ultrarrápida, búsqueda de texto completo con `bm25`, historial de 72 h (`articles_history`), informes (`briefing_reports`) y caché de traducciones (`translations_cache`). |
| **Cómputo Paralelo en GPU** | **WebGPU Compute Shaders (`WGSL`)** | Kernel `@compute @workgroup_size(64)` con operaciones vectoriales `vec4<f32>` (`dot`, `clamp`) sobre *Storage Buffers* para calcular la matriz de afinidad temática en `< 2 ms`. |
| **Gráficos en GPU** | **WebGPU Render Pipeline (`WGSL`) + Canvas 2D** | Shaders `@vertex` y `@fragment` para el **Espectro de Impacto** (campos escalares térmicos y anillos SDF) y para el procesado de color de las tarjetas de noticias. |
| **IA e Inteligencia Local** | **Ollama (`http://127.0.0.1:11434`) + `Gemma 4`** | Síntesis ejecutiva estructurada en español y traducción neuronal en lotes de titulares internacionales, funcionando 100 % en memoria unificada local. |
| **Frontend** | **Vanilla JS (`ES2024`), HTML5 `<dialog>`, CSS Grid** | Interfaz reactiva sin frameworks pesados ni pasos de compilación (*buildless*). |

---

## 📂 Estructura del Proyecto

```text
feedly-local-webgpu/
├── server.js                        # Servidor HTTP nativo, motor RSS/Atom, SQLite FTS5, clustering TF-IDF y agente Ollama
├── package.json                     # Configuración para Node.js >= 22.5.0 (0 dependencias externas)
├── feedly-organizado.opml           # Catálogo curado de 196 fuentes en 8 carpetas temáticas (auto-importable)
├── iniciar-mac.command              # Lanzador directo de doble clic para macOS
├── iniciar-linux.sh                 # Lanzador directo para Linux
├── iniciar-windows.bat              # Lanzador directo para Windows
├── FeedlyLocal.command              # Acceso directo de escritorio para macOS (abre o levanta el servicio)
├── com.jesusconde.feedlylocal.plist # Definición de agente launchd para ejecución continua en macOS
├── Dockerfile                       # Imagen Docker ligera basada en node:22-alpine
├── docker-compose.yml               # Orquestación Docker con volumen persistente ./data
├── data/                            # (Auto-generado) Base de datos SQLite local y archivos WAL
└── public/
    ├── index.html                   # Interfaz principal, barra superior, lector lateral y modal «Informes en Vivo»
    ├── styles.css                   # Sistema de diseño Magazine 3-columnas, Modo Claro/Oscuro y estilos del Dossier IA
    ├── app.js                       # Estado reactivo, pipeline WebGPU de tarjetas y controlador de «Informes en Vivo»
    └── webgpu-briefing.js           # Motor WebGPU/WGSL de Informes: Compute Shader SIMD vec4 y Render Shader del Radar
```

---

## 🚀 Instalación y Puesta en Marcha

### 1. Requisitos previos
1. **Node.js v22.5.0 o superior** (incluye de serie el módulo nativo `node:sqlite`).
   * Descarga oficial: [https://nodejs.org/](https://nodejs.org/)
2. **Navegador compatible con WebGPU** (Chrome 113+, Edge 113+, Brave o Safari Technology Preview / macOS Sequoia+). Si el navegador no tiene WebGPU activo, la aplicación utiliza automáticamente el respaldo en Canvas 2D.
3. **Ollama (Opcional pero recomendado para Síntesis IA y Traducción Local):**
   * Descarga desde [https://ollama.com/](https://ollama.com/) y descarga el modelo **Gemma 4**:
     ```bash
     ollama pull gemma4
     ```
   * *(Si Ollama no está en ejecución, el agente sigue funcionando al 100 % mediante su motor algorítmico local TF-IDF + Deep Read).*

### 2. Clonar el repositorio

```bash
git clone https://github.com/0utKast/feedly-local-webgpu.git
cd feedly-local-webgpu
```

### 3. Iniciar la aplicación (Sin `npm install`)

Al no utilizar paquetes externos, no es necesario ejecutar `npm install`. Arranca directamente con:

```bash
npm start
```

O utiliza los **lanzadores directos por sistema operativo** incluidos en la raíz (inician el servidor en el puerto `3040` y abren automáticamente el navegador):

* **macOS:** Doble clic en `iniciar-mac.command` (o `./iniciar-mac.command`).
* **Linux:** Ejecuta `./iniciar-linux.sh`.
* **Windows:** Doble clic en `iniciar-windows.bat`.

Una vez iniciado, abre en tu navegador:
👉 **[http://localhost:3040](http://localhost:3040)**

---

## ⚙️ Ejecución como Servicio Siempre Activo en macOS (`launchd`)

Para aprovechar al máximo el **monitoreo horario automático** (de modo que los informes de `1h`, `12h`, `24h` y `Actuales` estén siempre listos al abrir el navegador):

1. Copia el archivo `com.jesusconde.feedlylocal.plist` a `~/Library/LaunchAgents/` ajustando la ruta de tu proyecto si fuera necesario.
2. Carga e inicia el servicio con:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.jesusconde.feedlylocal.plist
   launchctl kickstart -k gui/$(id -u)/com.jesusconde.feedlylocal
   ```

---

## 🐳 Ejecución con Docker (Opcional)

```bash
docker compose up -d
```

La base de datos SQLite (`feedly_local.sqlite`), tus artículos guardados, notas personales e informes históricos se conservarán automáticamente en el directorio `./data`.

---

## 🔌 API REST Local (Referencia para Desarrolladores)

El servidor expone una API JSON limpia en `http://localhost:3040`:

* `GET /api/state` — Estado general, contadores de carpetas/fuentes, lista paginada de artículos y estado de sincronización.
* `GET /api/briefings` — Devuelve instantáneamente los 4 informes ejecutivos pre-calculados (`unread`, `1h`, `12h`, `24h`), estado de Ollama y modelos detectados.
* `POST /api/briefings/generate` — Fuerza la regeneración en vivo de un alcance concreto (`{ "scope": "unread", "useOllama": true, "model": "gemma4:latest" }`).
* `POST /api/sync` — Lanza la sincronización en paralelo de todas las fuentes o de una categoría/feed específico.
* `POST /api/articles/mark-read` — Marca artículos como leídos por IDs, por antigüedad (`olderThanHours`) o por lote de clúster, eliminándolos de la bandeja de no leídos (respetando los guardados).
* `POST /api/articles/restore` — Deshace el último marcado como leído.
* `GET /api/articles/:id/fulltext` — Extrae y limpia los párrafos del artículo original para lectura profunda.

---

## 📄 Licencia

Publicado bajo licencia **MIT**. Libre para uso personal, educativo, análisis técnico y modificación.

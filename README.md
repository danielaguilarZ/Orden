# Orden

Tu asistente personal local: un **equipo de agentes de Claude** que viven en una casa isométrica en pixel art.
Les encargas cosas (finanzas, tareas, agenda, salud, trámites, aprendizaje…) y ves cómo trabajan en vivo:
caminan a su mesa, se delegan trabajo y construyen paneles (calendarios, tablas, tableros, gráficos, hábitos…)
que se actualizan delante de ti.

Esta es la **versión base**: empieza con un solo agente, **Zen** (el jefe), y una sola sala, su despacho.
El resto del equipo, las salas, la memoria y los paneles los vas creando tú (o se los pides a Zen).

## Requisitos

- Node.js **22.13 o superior** (usa `node:sqlite`; no hay que compilar nada)
- Una cuenta de Claude con plan **Pro o Max** (los agentes usan tu sesión local de Claude Code) o una API key
- Windows 11, macOS o Linux

## Instalación

```bash
git clone https://github.com/danielaguilarZ/Orden.git
cd Orden
npm install
npm run dev
```

Abre <http://localhost:3000>. Se arrancan dos procesos: la web (Next.js, solo en `127.0.0.1:3000`) y el
**worker**, que ejecuta encargos y rutinas en segundo plano. La base de datos se crea sola en `data/orden.db`.

Versión optimizada: `npm run build` y después `npm start`.

### Conectar con Claude

- **Desde la web:** pulsa el indicador «Claude» (arriba a la derecha) → «Conectar con Claude» y autoriza en el navegador.
- **Desde la terminal:** `npm run claude:login` y `npm run claude:status`.

¿Prefieres API key? Copia `.env.example` a `.env` y pon `ORDEN_AUTH_MODE=apikey` y `ANTHROPIC_API_KEY=...`.

### Dejarlo siempre en marcha (Windows)

`npm run servicio:instalar` crea una tarea programada que arranca Orden al iniciar sesión, sin ventana.
También: `servicio:estado`, `servicio:parar`, `servicio:arrancar` y `servicio:quitar`.

## Uso

| Página | Para qué |
| --- | --- |
| **Living** | La casa. Escribe «Encárgale algo a Zen…», añade agentes y pulsa en cada uno para chatear, ver sus rutinas o editarlo. |
| **Paneles** | Tus listas, tableros, calendarios, tablas, notas, hábitos y gráficos. Créalos con una plantilla (un clic) o pídeselos a un agente; se editan a mano y cada uno tiene «Pedir cambios» y un menú «⋯» (exportar `.md`/`.csv`/`.xlsx`/`.ics`, historial, tamaño, papelera). Pestaña **Archivos** para tus documentos. |
| **Memoria** | Tu perfil de vida (quién eres, objetivos, preferencias, personas…). La consultan y amplían todos los agentes. |
| **Actividad** | Registro de encargos, rutinas, cambios y errores. |


### Conexiones disponibles

| Servicio | Qué permite | Credencial |
| --- | --- | --- |
| GitHub | Leer y comentar; con permiso completo, ramas, commits y PRs (nunca fusiona). | `gh` del PC o token fine-grained cifrado |
| Google Calendar | Leer la agenda y volcarla a un panel. Solo lectura. | OAuth en el navegador (calendar.readonly) |
| Tiempo (clima) | Tiempo actual y previsión hasta 7 días (Open-Meteo). Solo lectura. | Ninguna |
| Noticias (RSS) | Titulares de las fuentes RSS/Atom que elijas (máx. 15). Solo lectura. | Ninguna |
| Telegram (avisos) | Con permiso completo, avisos de texto a tu chat: máx. 1000 caracteres y 20 al día. | Token del bot, cifrado |
| Notion | Buscar y leer las páginas que compartas con la integración; con permiso completo, añadir texto al final (nunca borra). | Secreto de integración, cifrado |

Cada ficha explica **cómo conectarla paso a paso**. Las credenciales se guardan cifradas (AES-256-GCM) y nunca
se muestran enteras ni aparecen en mensajes de error. Próximamente (con ficha en la pestaña): Tareas (Todoist),
Google Drive/Docs, Gmail (lectura y borradores), Outlook/Microsoft 365, correo IMAP, Home Assistant, bancos
(CSV/Open Banking), WhatsApp y Spotify.

Ejemplos de encargos para Zen:

- «Créame un calendario de esta semana con: lunes gimnasio a las 19:00, miércoles dentista a las 10:00.»
- «Contrata a Ana, especialista en finanzas personales, y pídele un presupuesto mensual con gráfico.»
- «Apunta en la memoria que mi pareja es Laura y su cumpleaños es el 12 de marzo.»
- «Cada día laborable a las 8:00 prepárame un resumen del día.»

Cada agente nuevo recibe un escritorio en una «Oficina compartida» que se abre sola. Las salas por ámbito
(cocina, biblioteca, gimnasio, viajes…) se crean a demanda y se amueblan solas; también se pueden decorar a mano.

### Modo decorar

Botón **«Decorar»** del living (o «Decorar a mano» en la ficha de un agente), al estilo Habbo y en la propia sala:

- La cámara encuadra la sala y se superpone su rejilla (los pasos de puerta, en ámbar).
- Un mueble se coge pulsándolo y se arrastra: la sombra va **verde si cabe y roja si no** (sin solapes, sin
  salirse, sin tapar puertas, adornos solo en muro alto, objetos pequeños encima de una mesa).
- Sobre el mueble elegido sale una barra pequeña: **girar** (R), **duplicar** (Ctrl+D) y **quitar** (Supr).
- A la derecha, un **inventario plegable**: «Muebles» (buscar y arrastrar a la sala; un clic lo pone en un hueco
  libre), «Suelo y paredes» y «Sala» (nombre, recolocar automáticamente, borrar, papelera y «+» para crear otra).
- Arriba: Deshacer (Ctrl+Z), Descartar, Guardar y Salir. Nada se guarda hasta «Guardar».

Lógica pura en `src/living/decorMode.ts` y `src/living/roomEditor.ts`; la escena (`scene.ts`) pinta rejilla,
sombra y selección, y la interfaz es `src/components/DecorMode.tsx`.

## Configuración (`.env`, opcional)

| Variable | Por defecto | Para qué |
| --- | --- | --- |
| `ORDEN_AUTH_MODE` | `subscription` | `subscription` (sesión de Claude Code) o `apikey` |
| `ORDEN_DB_PATH` | `./data/orden.db` | Base de datos SQLite |
| `ORDEN_EXPORT_DIR` | `./exportaciones` | Carpeta de exportación |
| `ORDEN_MAX_CONCURRENCY` | `3` | Encargos simultáneos del worker |
| `ORDEN_TZ` | `Europe/Madrid` | Zona horaria que ven los agentes |
| `ORDEN_SECRET_KEY` | (se crea `data/secreto.key`) | Clave para cifrar los tokens de Conexiones |
| `ORDEN_FILES_DIR` | `data/archivos` | Carpeta de los archivos subidos |
| `ORDEN_FILES_MAX_MB` | `25` | Tamaño máximo por archivo |

Todo lo personal (base de datos, archivos, tokens cifrados, registros) vive en `data/`, que está fuera de git.

## Desarrollo

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Web y worker en desarrollo |
| `npm test` | Tests (Vitest) |
| `npm run typecheck` | Comprobación de tipos |
| `npx tsx scripts/preview-living.ts casa.png` | PNG con todas las plantillas de sala |

Stack: Next.js 16 + React 19, PixiJS 8 (living), SQLite con `node:sqlite`, Claude Agent SDK.

```
src/
  app/         páginas y rutas API
  components/  interfaz React
  client/      estado del cliente y conexión SSE
  lib/         BD y migraciones, agentes, paneles, memoria, rutinas, conexiones, archivos, decisiones
  living/      motor isométrico (plano, A*, rasterizador, muebles, avatares, decorador)
worker/        proceso en segundo plano (encargos, rutinas, latido)
scripts/       arranque, servicio de Windows, login de Claude y vistas previas
tests/         tests de la lógica
```

## Licencia

[MIT](LICENSE) © 2026 Daniel Aguilar

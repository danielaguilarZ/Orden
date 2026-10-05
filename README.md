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
| **Paneles** | Lo que crean los agentes (calendario, kanban, lista, tabla, notas, gráfico, hábitos). Edición a mano, historial, exportar (`.md`, `.csv`, `.xlsx`, `.ics`). Pestaña **Archivos** para tus documentos. |
| **Memoria** | Tu perfil de vida (quién eres, objetivos, preferencias, personas…). La consultan y amplían todos los agentes. |
| **Actividad** | Registro de encargos, rutinas, cambios y errores. |
| **Conexiones** | Servicios externos opcionales (GitHub, Google Calendar en solo lectura) y el permiso de cada agente. No hay ninguna conectada de serie. |
| **Decisiones** | Solo lo que el equipo necesita que decidas, con un contador en la pestaña. |

### Decisiones

Cuando un agente necesita algo de ti (aprobar una idea, elegir entre opciones, un dato, un login), lo plantea
como **decisión**: título, contexto breve, opciones sugeridas si las hay y una caja para responder. Según el caso
responderás con texto, con una opción o con **Aceptar / Rechazar** (con comentario opcional); «Más tarde» la aplaza
1 día, 1 semana o 1 mes. Tu respuesta le llega al agente que la planteó como mensaje en su chat y la decisión pasa
a «Resueltas» (plegado, con opción de reabrirla). Lo rechazado no se vuelve a plantear.

- Código en `src/lib/decisions/` (`labels.ts` sin dependencias de servidor, `repo.ts`, `tools.ts`), pestaña en
  `/decisiones` (la antigua `/propuestas` redirige) y API en `/api/decisions`.
- Herramientas de los agentes: `decision_crear`, `decisiones_listar` y `decision_retirar` (sustituyen a
  `propuesta_crear` / `propuestas_listar`).
- La migración 15 pasa las propuestas pendientes a decisiones y lo pendiente del antiguo panel «Acción humana» a
  decisiones de Zen. No borra nada.

Ejemplos de encargos para Zen:

- «Créame un calendario de esta semana con: lunes gimnasio a las 19:00, miércoles dentista a las 10:00.»
- «Contrata a Ana, especialista en finanzas personales, y pídele un presupuesto mensual con gráfico.»
- «Apunta en la memoria que mi pareja es Laura y su cumpleaños es el 12 de marzo.»
- «Cada día laborable a las 8:00 prepárame un resumen del día.»

Cada agente nuevo recibe un escritorio en una «Oficina compartida» que se abre sola. Las salas por ámbito
(cocina, biblioteca, gimnasio, viajes…) se crean a demanda y se amueblan solas; también se pueden editar a mano.

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

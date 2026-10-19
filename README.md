# Worktree Panel

Panel web local para trabajar tareas de Jira con Claude Code. Cada tarea vive en su propio **git worktree**, con la rama y la base que elijas, su documentación en `.task/` y una sesión de Claude Code embebida en el navegador.

Pensado para Windows 10/11 (también funciona en macOS y Linux). Todo corre en tu máquina: el servidor escucha solo en `127.0.0.1`.

## Requisitos

- **Node.js 20 o superior** con npm (probado con 25.8)
- **Git** (en Windows, Git for Windows)
- **[Claude Code](https://code.claude.com)** instalado, en el `PATH` y con la sesión iniciada (`claude --version` debe funcionar)

No hace falta compilador ni Visual Studio Build Tools: `node-pty` se instala con binarios precompilados.

## Instalación y arranque

```powershell
git clone https://github.com/AleLahoz/worktree-panel.git
cd worktree-panel
npm install
npm start
```

Cuando veas `Worktree Panel escuchando en http://127.0.0.1:4317`, abre esa dirección en el navegador. Para pararlo, `Ctrl+C` (eso cierra también las sesiones de Claude en marcha).

Antes de empezar puedes comprobar el entorno con `npm run env-check`: verifica git, Claude Code y `node-pty`, y muestra qué falta.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Compila el frontend y lo sirve junto al backend en `http://127.0.0.1:4317` (uso normal) |
| `npm run dev` | Desarrollo: backend con recarga en `:4317` y Vite en `:5173` (abre `http://127.0.0.1:5173`) |
| `npm run build` | Compila frontend (`web/dist`) y backend (`server/dist`) |
| `npm test` | Tests del servidor, con repos git temporales reales (no tocan los tuyos) |
| `npm run env-check` | Comprueba git, Claude Code y `node-pty` en esta máquina |

Variables opcionales: `PORT` (por defecto `4317`) y `WTP_DATA_DIR` (carpeta de datos).

## Si algo falla

- **`npm` no se encuentra o falla con un error de `npm-prefix.js`**: la instalación de Node está incompleta. Con fnm, `fnm install 24 --force` (o usa otra versión con `fnm use <versión>`).
- **El panel dice que Claude Code no está disponible**: `claude` no está en el `PATH` de la terminal desde la que arrancaste el panel. Abre una nueva terminal tras instalarlo, o indica la ruta en Ajustes → General.
- **Puerto ocupado**: arranca con otro puerto, `$env:PORT=4400; npm start` en PowerShell.
- **Errores con rutas largas en Windows dentro de un worktree**: `git config --global core.longpaths true`.

Los datos (repos, tareas, configuración) se guardan como JSON en `%APPDATA%\worktree-panel\` (`~/.worktree-panel/` en otros sistemas). Con `WTP_DATA_DIR` puedes usar otra carpeta y con `PORT` otro puerto.

## Flujo de trabajo

1. **Ajustes → Añadir repositorio**: ruta del checkout y, si la tienes, la rama base habitual (p. ej. `origin/develop`). Se añaden `.claude/worktrees/` y `.task/` a `.git/info/exclude`, sin tocar el `.gitignore` del equipo.
2. **Nueva tarea** (`Ctrl+N`): clave (`PROJ-123`), rama nueva o existente y **rama base elegida siempre explícitamente**. Puedes arrastrar documentos al crearla.
3. **Claude**: la sesión arranca en el worktree y escribe el prompt inicial (sin pulsar Enter por ti). Puedes tener varias tareas trabajando a la vez; al volver a una, su terminal sigue ahí con todo el historial.
4. **Documentos**: arrastra ficheros a cualquier parte de la tarea. Un clic inserta `@.task/fichero` en el prompt de Claude.
5. **Git**: cambios y diff de solo lectura, **Push** (se bloquea si `.task/` estuviera en el índice) y **Abrir PR** contra la base de la tarea (GitHub, GitLab, Bitbucket y Azure DevOps; plantilla propia para otros).
6. **Cerrar tarea**: avisa si hay trabajo sin subir y exige escribir la clave para confirmarlo. La rama se conserva salvo que marques lo contrario.

## Cosas que conviene saber

- **Claude se lanza con el directorio de trabajo en el worktree, sin `--worktree`.** Con `--worktree`, Claude Code borra el worktree (y `.task/`) al salir si no hay cambios rastreados. Detalles en [`docs/fase0-informe.md`](docs/fase0-informe.md).
- **Retomar fuera del panel**: dentro del worktree, `claude --resume <sessionId>` abre la misma conversación (el id está en el JSON de la tarea).
- Si reinicias el backend, las terminales mueren: las tareas quedan "Detenida" y se retoman con **Retomar sesión**.
- Activa las notificaciones en Ajustes para que el navegador te avise cuando una tarea espere tu respuesta.
- En Windows, `git config --global core.longpaths true` evita problemas con rutas largas dentro de los worktrees.

## Estructura

```
server/   Fastify + node-pty + ws (TypeScript). Servicios: GitService, TaskStore, TaskService,
          PtyManager, SessionService, DocService, PrUrl
web/      React + Vite + xterm.js
docs/     informe de la Fase 0
worktree-panel-spec.md   especificación original (con los cambios que impuso la Fase 0)
```

## Fuera del alcance (por ahora)

Integración con la API de Jira, creación de PR por API, UI propia con el Agent SDK, autenticación y despliegue remoto.

## Licencia

[MIT](LICENSE)

# Worktree Panel

Panel web local para trabajar tareas de Jira con Claude Code. Cada tarea vive en su propio **git worktree**, con la rama y la base que elijas, su documentación en `.task/` y una sesión de Claude Code embebida en el navegador.

Pensado para Windows 10/11 (también funciona en macOS y Linux). Todo corre en tu máquina: el servidor escucha solo en `127.0.0.1`.

## Requisitos

- Node.js 20 o superior (probado con 25.8)
- Git for Windows
- [Claude Code](https://code.claude.com) instalado y con la sesión iniciada

## Uso

```powershell
npm install
npm run dev      # desarrollo: backend en :4317 y Vite en :5173 (abre http://127.0.0.1:5173)
npm start        # producción: compila el frontend y lo sirve desde http://127.0.0.1:4317
npm test         # tests del servidor (repos temporales reales, sin tocar los tuyos)
npm run env-check  # comprueba git, claude y node-pty en esta máquina
```

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

# Worktree Panel — Especificación funcional y técnica

> Panel web local para trabajar tareas de Jira con Claude Code, cada una aislada en su propio git worktree, con su documentación funcional adjunta y su terminal de Claude Code embebida.

---

## 0. Instrucciones para Claude Code (léelo primero)

- Implementa el proyecto **por fases** (sección 13). Al terminar cada fase, para, resume qué has hecho y cómo probarlo, y espera confirmación antes de seguir.
- **Fase 0 es un spike obligatorio**: verifica en esta máquina los puntos de la sección 15 antes de construir nada encima. Si algún supuesto falla, propón alternativa antes de continuar.
- El entorno objetivo es **Windows 10/11**. Todo comando, ruta y proceso debe funcionar ahí (rutas con `\`, `claude.exe`/`claude.cmd`, PowerShell). Usa `path` de Node, nunca concatenes rutas a mano.
- No añadas funcionalidades fuera del alcance (sección 3) sin preguntar.
- Nunca ejecutes git con strings de shell concatenados: usa `execFile`/`spawn` con array de argumentos.
- Escribe tests para el servicio de git usando repositorios temporales (`git init` en un directorio temporal).

---

## 1. Contexto y objetivo

El usuario trabaja tareas de Jira "vibecodeando" con Claude Code: descarga el documento funcional, abre Claude Code, le indica la rama, Claude implementa, el usuario sube los cambios y crea el PR.

Problemas actuales:

- Cambiar de tarea a mitad obliga a hacer `stash` o commits temporales.
- La documentación de cada tarea está suelta por el disco y se pasa a mano.
- No hay una vista de qué tareas están en curso, en qué rama y en qué estado.
- Las ramas de trabajo **no siempre salen de la rama principal** del repo: a menudo el cliente usa otra rama (p. ej. `develop`, `release/x`) como base real, así que la base debe elegirse siempre explícitamente.

Objetivo: una aplicación local (frontend + backend en el PC del usuario) donde cada tarea = un worktree con rama y base elegidas, una carpeta de documentos y una sesión de Claude Code visible y controlable desde el navegador.

---

## 2. Glosario

| Término | Significado |
|---|---|
| **Repo** | Repositorio git local registrado en el panel (ruta al checkout principal). |
| **Tarea** | Unidad de trabajo, identificada por una clave (p. ej. `PROJ-123`). Pertenece a un repo. |
| **Worktree** | Directorio `<repo>/.claude/worktrees/<clave>` con la rama de la tarea. |
| **Rama base** | Rama/ref de la que sale la rama de la tarea (p. ej. `origin/develop`). Siempre elegida por el usuario. |
| **Documentos** | Ficheros de contexto de la tarea (funcional, specs, capturas) en `<worktree>/.task/`. |
| **Sesión** | Proceso de Claude Code asociado a la tarea, identificado por un UUID de sesión. |

---

## 3. Alcance

### Dentro del MVP

- Registrar repos locales.
- Crear tarea → crear worktree con **nombre de rama libre** y **rama base libre** (o usar una rama existente).
- Adjuntar documentos por drag & drop e insertar su referencia `@` en Claude Code.
- Terminal embebida (xterm.js) con Claude Code ejecutándose en una pseudo-terminal real; varias sesiones simultáneas.
- Iniciar, retomar y detener sesiones de Claude Code por tarea.
- Ver estado git de cada tarea.
- Push de la rama y apertura de la URL de creación del PR.
- Cerrar tarea (eliminar worktree con comprobaciones de seguridad).
- Pestaña de shell libre (PowerShell) en el worktree.

### Fuera del MVP (fase futura, no implementar)

- Integración con la API de Jira (importar título, descripción y adjuntos).
- Creación del PR vía API del proveedor (en el MVP solo se abre la URL).
- Modo "UI propia" con Claude Agent SDK en lugar de terminal.
- Autenticación, multiusuario, despliegue remoto.
- Hook `WorktreeCreate` para paridad con `claude -w` desde la CLI.

---

## 4. Requisitos funcionales

### RF1 — Repositorios

- Añadir repo indicando su ruta local. Validar que es un checkout git (`git -C <ruta> rev-parse --show-toplevel`) y guardar la raíz real.
- Nombre visible editable (por defecto, el nombre de la carpeta).
- Al registrar, añadir (si no existen) estas líneas a `<git-common-dir>/info/exclude` (se obtiene con `git rev-parse --git-common-dir`; aplica a todos los worktrees y **no** toca el `.gitignore` del equipo):
  ```
  .claude/worktrees/
  .task/
  ```
- Configuración opcional por repo:
  - `defaultBase`: rama base sugerida (p. ej. `origin/develop`). Solo preselección; el usuario siempre puede cambiarla.
  - `branchTemplate`: plantilla de nombre de rama sugerido (por defecto `feature/{key}`).
  - `setupCommand`: comando a ejecutar en la shell del worktree tras crearlo (p. ej. `npm ci`). Opcional.
  - `prUrlTemplate`: plantilla de URL de PR si no se puede deducir del remoto.
- Botón "Fetch" → `git -C <repo> fetch --prune origin`.

### RF2 — Crear tarea

Formulario (modal "Nueva tarea"):

| Campo | Obligatorio | Notas |
|---|---|---|
| Repo | Sí | Selector. |
| Clave | Sí | Ej. `PROJ-123`. Solo `[A-Za-z0-9._-]`. Única por repo. Es el nombre del worktree. |
| Título | No | Texto libre. |
| URL de Jira | No | Para tener el enlace a mano. |
| Modo de rama | Sí | **Nueva rama** o **Rama existente**. |
| Nombre de rama | Sí (nueva) | Prellenado con `branchTemplate`. Validar con `git check-ref-format --branch <nombre>` y que no exista local ni en remoto. |
| Rama base | Sí (nueva) | Selector con búsqueda de **todas** las ramas locales y remotas (`git for-each-ref --format=%(refname:short) refs/heads refs/remotes`). Preselección: `defaultBase` del repo; si no hay, ninguna (obligar a elegir). Nunca asumir `main`. |
| Rama existente | Sí (existente) | Selector de ramas locales y remotas. |
| Documentos | No | Drop zone en el propio modal. |

Al confirmar:

1. `git -C <repo> fetch origin` (si falla por red, avisar y continuar con lo cacheado).
2. Crear worktree:
   - Nueva rama: `git -C <repo> worktree add --no-track -b <rama> .claude/worktrees/<clave> <base>`
     (`--no-track` evita que la rama nueva quede siguiendo a la base y un `git push` acabe apuntando a `develop`).
   - Rama existente local: `git -C <repo> worktree add .claude/worktrees/<clave> <rama>`
   - Rama existente solo remota (`origin/x`): `git -C <repo> worktree add --track -b x .claude/worktrees/<clave> origin/x`
3. Crear `<worktree>/.task/` y copiar los documentos adjuntados.
4. Guardar la tarea (sección 7) con `base` sin el prefijo del remoto para el PR (p. ej. `develop`).
5. Si el repo tiene `setupCommand`, abrir la pestaña Shell y ejecutarlo.
6. Opcional (checkbox marcado por defecto): iniciar sesión de Claude (RF4).

Errores a contemplar: la rama ya existe, el directorio del worktree ya existe, la base no existe, la rama ya está en uso en otro worktree (git lo impide: mostrar en qué worktree está).

### RF3 — Documentos

- Drop zone en toda la vista de la tarea (overlay al arrastrar) y botón "Añadir ficheros".
- Tipos admitidos: `.md`, `.txt`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.json`, `.csv`, `.xml`, `.html`. Para otros (p. ej. `.docx`) avisar de que Claude Code puede no leerlos bien y sugerir exportar a PDF o Markdown; permitir subirlos igualmente.
- Tamaño máximo: 50 MB por fichero.
- Se guardan en `<worktree>/.task/<nombre-saneado>`. Saneado: quitar separadores de ruta y caracteres no válidos en Windows (`<>:"/\|?*`); si existe, añadir sufijo `-2`, `-3`…
- Lista de documentos con: nombre, tamaño, fecha, acciones **Insertar en Claude**, **Abrir** (abre con la aplicación del sistema) y **Eliminar** (con confirmación).
- **Insertar en Claude**: escribe en la pseudo-terminal de la sesión activa `@.task/<nombre> ` (con espacio final y **sin** Enter), para que el usuario complete el mensaje.
- Si se suelta un fichero con la sesión en marcha: tras guardarlo, mostrar un aviso "¿Insertar referencia en Claude?" con botón de un clic.

### RF4 — Sesiones de Claude Code

- **Iniciar sesión**:
  - Generar `sessionId` (UUID v4) y guardarlo en la tarea.
  - Lanzar en pseudo-terminal, con **cwd = el worktree de la tarea** y **sin `--worktree`**:
    `claude --session-id <sessionId>`
    > **Cambio respecto a la versión inicial (Fase 0).** Con `--worktree`, Claude Code borra el directorio del worktree al salir si no hay cambios rastreados (incluida `.task/`, que git ignora), y al retomar con `--worktree … --resume` lo recrea en una rama nueva desde la principal. Lanzando desde el propio worktree no ocurre nada de eso y la rama/base elegidas se respetan. Ver `docs/fase0-informe.md`.
  - Cuando la terminal muestre la primera salida y quede estable ~1,5 s, escribir el **prompt inicial** (plantilla abajo) **sin** Enter. El usuario lo revisa y pulsa Enter. No pasar el prompt como argumento de línea de comandos (evita problemas de escapado en Windows).
- **Retomar sesión** (si la tarea tiene `sessionId` y no hay proceso vivo):
  `claude --resume <sessionId>` (cwd = el worktree). Si falla, ofrecer "Iniciar nueva sesión" manteniendo el worktree.
- **Detener sesión**: enviar `Ctrl+C` dos veces; si sigue vivo a los 5 s, matar el proceso. No borra nada.
- Varias sesiones vivas a la vez (una por tarea). Cambiar de tarea en la UI **no** detiene procesos.
- **Reconexión**: el backend guarda un buffer circular de la salida de cada pty (~1 MB o 5.000 líneas). Al recargar la página o reabrir la tarea, se reenvía el buffer para que la terminal se vea como estaba.
- Si el backend se reinicia, los procesos mueren: las tareas quedan como "Detenida" y se pueden retomar con `--resume`.
- Indicador de estado de sesión: `Sin sesión` · `En ejecución` (salida en los últimos 3 s) · `Esperando` (proceso vivo sin salida > 3 s; suele ser que Claude espera respuesta) · `Detenida`.
- Notificación del navegador (opcional, con permiso) cuando una tarea pasa a `Esperando` y no es la tarea visible.

Plantilla de prompt inicial (editable en configuración global):

```
Vas a trabajar la tarea {key}{title_suffix}.
Estás en la rama {branch}, que sale de {base}. Los PR irán contra {base}.
Documentación de la tarea: {doc_refs}
Antes de programar: lee la documentación, resume lo que entiendes y propón un plan. Espera mi confirmación.
```

`{doc_refs}` = lista de `@.task/<fichero>` separados por espacios, o "(sin documentos)".

### RF5 — Estado git de la tarea

Mostrar en la cabecera de la tarea y como badges en el listado:

- Rama y base.
- Cambios sin commitear: `git -C <wt> status --porcelain=v1` (número de ficheros).
- Commits sin subir:
  - Con upstream: `git -C <wt> rev-list --count @{u}..HEAD`.
  - Sin upstream: `git -C <wt> rev-list --count <baseRef>..HEAD`.
- Commits por detrás de la base: `git -C <wt> rev-list --count HEAD..<baseRef>`.
- Último commit: `git -C <wt> log -1 --format=%h%x09%s%x09%cr`.
- Refresco: al abrir la tarea, tras cada operación, cada 10 s mientras la tarea esté visible y botón manual.
- Pestaña **Git**: lista de ficheros cambiados y diff de cada uno (`git diff`, `git diff --cached`, ficheros nuevos). Solo lectura en el MVP.

### RF6 — Publicar y PR

- Botón **Push**: `git -C <wt> push -u origin <rama>`. Mostrar la salida. Antes, si `git -C <wt> ls-files .task` devuelve algo, bloquear y avisar (la documentación nunca se debe subir).
- Botón **Abrir PR**: construir la URL a partir del remoto `origin` y abrirla en el navegador. Destino del PR = `base` de la tarea (no la principal del repo).
  - Normalizar el remoto a URL web: `git@host:org/repo.git` → `https://host/org/repo`; quitar `.git` y las credenciales de las URLs https.
  - Plantillas por proveedor (detectar por host; si no se reconoce, usar `prUrlTemplate` del repo):

| Proveedor | URL |
|---|---|
| GitHub | `{web}/compare/{base}...{branch}?expand=1` |
| GitLab | `{web}/-/merge_requests/new?merge_request[source_branch]={branch}&merge_request[target_branch]={base}` |
| Bitbucket Cloud | `{web}/pull-requests/new?source={branch}&dest={base}` |
| Azure DevOps | `{web}/pullrequestcreate?sourceRef={branch}&targetRef={base}` |

  Codificar `{branch}` y `{base}` con `encodeURIComponent`.
- Campo opcional "URL del PR" en la tarea para guardarlo cuando exista.

### RF7 — Cerrar tarea

1. Comprobar cambios sin commitear y commits sin subir (RF5).
2. Mostrar un resumen y pedir confirmación. Si hay trabajo sin subir, exigir escribir la clave para confirmar.
3. Detener la sesión si está viva.
4. `git -C <repo> worktree remove .claude/worktrees/<clave>` (con `--force` solo si el usuario lo confirmó explícitamente con cambios pendientes). Si está bloqueado: `git worktree unlock` y reintentar.
5. Checkbox "Borrar también la rama local" (desmarcado por defecto): `git branch -d <rama>` (o `-D` con confirmación extra).
6. `git -C <repo> worktree prune`.
7. Mover el JSON de la tarea a `archive/` (no borrarlo).

### RF8 — Shell libre

- Pestaña **Shell** por tarea: PowerShell (`powershell.exe -NoLogo`; configurable a `pwsh` o Git Bash) con cwd = worktree, en otra pty.
- Mismo comportamiento de buffer y reconexión que la sesión de Claude.

### RF9 — Listado de tareas

- Sidebar con tareas agrupadas por repo: clave, título, rama, badges (estado de sesión, cambios, commits sin subir).
- Filtro por texto.
- Al arrancar el backend, reconciliar con `git worktree list --porcelain` de cada repo: marcar tareas cuyo worktree ya no existe ("Worktree perdido": ofrecer archivar) y listar worktrees bajo `.claude/worktrees/` sin tarea ("Importar como tarea").

---

## 5. Requisitos no funcionales

- **Local**: el servidor escucha solo en `127.0.0.1` (puerto configurable, por defecto `4317`). Sin autenticación en el MVP.
- **Windows primero**: debe funcionar en Windows 10/11 con Git for Windows y Claude Code instalados. macOS/Linux deseable, sin bloquear.
- **Seguridad de datos**: ninguna operación destructiva (eliminar worktree, borrar rama o documento) sin confirmación. Nunca tocar el directorio de trabajo del checkout principal.
- **Sin base de datos**: ficheros JSON (sección 7), escritos de forma atómica (escribir a `.tmp` y renombrar).
- **Arranque simple**: `npm install` y `npm run dev` (desarrollo) / `npm start` (producción, sirve el frontend compilado desde el backend).
- **Rendimiento**: la terminal no debe perder salida ni bloquearse con salidas grandes (usar `ws` binario o por lotes de ~16 ms).

---

## 6. Arquitectura

```
Navegador (localhost:4317)
 ├─ React + Vite
 ├─ xterm.js (@xterm/xterm + @xterm/addon-fit + @xterm/addon-web-links)
 │        │ REST (JSON)            │ WebSocket (datos de terminal)
 ▼        ▼                        ▼
Backend Node (TypeScript)
 ├─ HTTP API (Fastify)
 ├─ WS hub: /ws/pty/:ptyId   ←→  PtyManager (node-pty)
 ├─ GitService   → git.exe (execFile, args en array)
 ├─ TaskStore    → JSON en carpeta de datos
 ├─ DocService   → <worktree>/.task/
 └─ SessionService → claude.exe/claude.cmd en pty
```

### Stack

| Pieza | Elección | Notas |
|---|---|---|
| Runtime | Node.js 20 LTS o superior | |
| Lenguaje | TypeScript en front y back | |
| Backend | Fastify + `@fastify/multipart` + `@fastify/static` + `ws` | |
| PTY | `node-pty` | En Windows usa ConPTY. Si la instalación exige Visual Studio Build Tools y falla, probar un fork con binarios precompilados (p. ej. `@lydell/node-pty`). Verificar en la Fase 0. |
| Frontend | React + Vite | Sin librería de UI pesada; CSS propio o Tailwind. |
| Terminal | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links` | |
| Validación | `zod` | |
| Tests | `vitest` | |

### Estructura del proyecto

```
worktree-panel/
├─ package.json            (workspaces: server, web)
├─ server/
│  ├─ src/
│  │  ├─ index.ts          (arranque, rutas, estáticos)
│  │  ├─ config.ts
│  │  ├─ routes/           (repos, tasks, docs, sessions, git)
│  │  ├─ services/         (GitService, TaskStore, DocService, PtyManager, SessionService, PrUrl)
│  │  └─ ws.ts
│  └─ test/
└─ web/
   └─ src/
      ├─ api/              (cliente REST)
      ├─ components/       (Sidebar, TaskHeader, TerminalView, DocsPanel, GitPanel, NewTaskModal, DropOverlay)
      └─ App.tsx
```

### Carpeta de datos

`%APPDATA%\worktree-panel\` en Windows (`~/.worktree-panel/` en otros sistemas):

```
config.json
repos.json
tasks/<taskId>.json
archive/<taskId>.json
logs/server.log
```

---

## 7. Modelo de datos

```ts
// config.json
interface AppConfig {
  port: number;                 // 4317
  claudePath: string;           // autodetectado con `where claude`; editable
  shellPath: string;            // "powershell.exe"
  initialPromptTemplate: string;
  defaultBranchTemplate: string; // "feature/{key}"
}

// repos.json
interface Repo {
  id: string;            // uuid
  name: string;
  path: string;          // raíz del checkout principal
  defaultBase?: string;  // "origin/develop"
  branchTemplate?: string;
  setupCommand?: string;
  prUrlTemplate?: string; // con {web} {branch} {base}
}

// tasks/<id>.json
interface Task {
  id: string;            // uuid
  repoId: string;
  key: string;           // "PROJ-123" = nombre del worktree
  title?: string;
  jiraUrl?: string;
  branch: string;        // "feature/PROJ-123"
  baseRef: string;       // "origin/develop" (para cálculos git)
  prBase: string;        // "develop" (destino del PR)
  worktreePath: string;  // <repo>/.claude/worktrees/<key>
  sessionId?: string;    // UUID de la sesión de Claude Code
  prUrl?: string;
  createdAt: string;     // ISO
  updatedAt: string;
}
```

Estado en memoria (no persistido): ptys vivas por tarea `{ claude?: PtyHandle; shell?: PtyHandle }`, buffer de salida, último timestamp de salida.

---

## 8. API

### REST (`/api`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/config` · PUT `/config` | Leer/guardar configuración. |
| GET | `/env/check` | Versiones de git, node y claude; resultado de los checks de la Fase 0. |
| GET | `/repos` · POST `/repos` · PATCH `/repos/:id` · DELETE `/repos/:id` | CRUD de repos (DELETE solo lo quita del panel). |
| POST | `/repos/:id/fetch` | `git fetch --prune origin`. |
| GET | `/repos/:id/branches` | Ramas locales y remotas. |
| GET | `/tasks` | Listado con estado resumido. |
| POST | `/tasks` | Crear tarea (RF2). |
| GET | `/tasks/:id` · PATCH `/tasks/:id` | Detalle / editar título, URL de Jira, URL del PR. |
| POST | `/tasks/:id/close` | Cerrar tarea (RF7). Body: `{ force?: boolean, deleteBranch?: boolean }`. |
| GET | `/tasks/:id/git/status` | RF5. |
| GET | `/tasks/:id/git/diff?file=` | Diff de un fichero. |
| POST | `/tasks/:id/git/push` | RF6. |
| GET | `/tasks/:id/pr-url` | URL calculada del PR. |
| GET | `/tasks/:id/docs` · POST `/tasks/:id/docs` (multipart) · DELETE `/tasks/:id/docs/:name` | RF3. |
| POST | `/tasks/:id/docs/:name/open` | Abrir con la aplicación del sistema. |
| POST | `/tasks/:id/session/start` · `/session/resume` · `/session/stop` | RF4. |
| POST | `/tasks/:id/session/insert` | Body `{ text }` → escribir en la pty de Claude sin Enter. |
| POST | `/tasks/:id/shell/start` · `/shell/stop` | RF8. |

### WebSocket

`/ws/pty/:taskId/:kind` (`kind` = `claude` | `shell`)

- Al conectar: el servidor envía el buffer acumulado y después la salida en vivo.
- Mensajes cliente → servidor: `{ "t": "in", "d": "<datos>" }` (teclado) y `{ "t": "resize", "cols": n, "rows": n }`.
- Mensajes servidor → cliente: `{ "t": "out", "d": "<datos>" }`, `{ "t": "exit", "code": n }`, `{ "t": "status", "s": "running|waiting|stopped" }`.
- Se permiten varios clientes por pty (varias pestañas del navegador).

---

## 9. Detalles de implementación delicados

1. **Lanzar Claude desde node-pty en Windows**: resolver `claudePath` con `where claude`. Si es `.cmd`, lanzar con `cmd.exe /d /s /c "<ruta>" <args>`; si es `.exe`, directamente. Pasar `cols/rows` reales del `fitAddon` y reenviar `resize`.
2. **cwd del proceso de Claude = el worktree de la tarea y sin `--worktree`** (verificado en la Fase 0: `--worktree` borra el worktree al salir sin cambios rastreados y lo recrea en otra rama al retomar; retomar con `--resume` desde el worktree funciona y conserva rama y `.task/`).
3. **Confianza del workspace**: la primera vez que se usa Claude en un directorio nuevo aparece el diálogo de confianza. Se ve y se responde en la terminal. El prompt inicial **espera** a que se acepte (no se escribe encima del diálogo).
4. **Detección de "listo" para escribir el prompt inicial**: primera salida + 1,5 s sin salida nueva, y sin el diálogo de confianza en pantalla. Si a los 15 s no ha ocurrido (o 5 min si hay diálogo), no escribir nada; queda el botón "Insertar prompt inicial".
4b. **Entorno del pty**: no heredar `CLAUDECODE`, `CLAUDE_CODE_*` ni `CLAUDE_PID`. Si el panel se arranca desde otra sesión de Claude, Claude desactiva los transcripts y `--resume` deja de funcionar.
4c. **Windows y directorios en uso**: tras terminar los procesos de una tarea, Windows tarda un instante en liberar su cwd. El cierre reintenta `git worktree remove` y, si git ya desregistró el worktree pero no pudo borrar el directorio, lo elimina (solo dentro de `.claude/worktrees/`).
5. **Rutas largas en Windows**: en la Fase 0, comprobar `git config core.longpaths`. Si no está a `true`, mostrar una recomendación en `/env/check` (no cambiarlo automáticamente).
6. **Dependencias por worktree**: cada worktree es un checkout nuevo (sin `node_modules`, etc.). Lo resuelve `setupCommand` o se le pide a Claude.
7. **Ficheros ignorados necesarios** (`.env`…): Claude Code copia los que indique `.worktreeinclude` solo cuando crea él el worktree; aquí lo crea el panel. Implementar la misma semántica: si existe `<repo>/.worktreeinclude`, copiar al worktree los ficheros que coincidan **y** estén ignorados por git (`git ls-files --others --ignored --exclude-standard` filtrado por los patrones).
8. **Codificación**: forzar salida de git en UTF-8 (`-c core.quotepath=off`, env `LC_ALL=C.UTF-8` donde aplique) y tratar los nombres de fichero con acentos.

---

## 10. Interfaz

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ [+ Nueva]    │ PROJ-123 · Ajustar cálculo de tasas         [Jira ↗]     │
│ 🔍 filtrar   │ feature/PROJ-123 ← origin/develop  ● Esperando           │
│              │ 3 cambios · 2 sin subir · 0 por detrás                   │
│ ▾ jumbo-web  │ [Iniciar/Retomar] [Detener] [Push] [Abrir PR] [Cerrar]   │
│  ● PROJ-123  ├──────────────────────────────────────────────────────────┤
│  ○ PROJ-118  │ [Claude] [Shell] [Documentos (2)] [Git]                  │
│ ▾ accenture  │ ┌──────────────────────────────────────────────────────┐ │
│  ○ ACN-77    │ │                                                      │ │
│              │ │   terminal xterm.js a pantalla completa              │ │
│              │ │                                                      │ │
│ [⚙ Ajustes]  │ └──────────────────────────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────────────────────────┘
```

- Al arrastrar un fichero sobre la tarea: overlay "Suelta para añadir a .task/ de PROJ-123".
- Pestaña **Documentos**: lista (RF3) y drop zone.
- Pestaña **Git**: ficheros cambiados a la izquierda, diff a la derecha.
- **Ajustes**: configuración global, gestión de repos y resultado de `/env/check`.
- Tema oscuro por defecto. La terminal ocupa todo el alto disponible y se reajusta al redimensionar.
- Atajos: `Ctrl+K` para buscar una tarea, `Ctrl+N` para crear una nueva.

---

## 11. Seguridad

- Escuchar solo en `127.0.0.1`. Rechazar peticiones cuyo `Origin` no sea `http://localhost:<port>` o `http://127.0.0.1:<port>` (también en el WebSocket).
- Validar con `zod` todos los inputs. Clave de tarea: `^[A-Za-z0-9._-]{1,64}$`.
- Comprobar que toda ruta resuelta de documentos queda dentro de `<worktree>/.task/` (proteger contra path traversal).
- Git y procesos siempre con `execFile`/`spawn` y array de argumentos; nunca `exec` con strings interpolados.
- No registrar en los logs el contenido de los documentos ni de la terminal.

---

## 12. Casos límite

| Caso | Comportamiento |
|---|---|
| Claude Code no instalado o no está en el PATH | `/env/check` lo indica; los botones de sesión se desactivan con explicación. |
| La rama ya existe | Error en el formulario con la opción "Usar rama existente". |
| La rama ya está en otro worktree | Mostrar en qué ruta está; no crear. |
| La base no existe tras el fetch | Error en el formulario. |
| El worktree se borró a mano | La tarea se marca como "Worktree perdido" (RF9). |
| `--resume` falla | Mostrar el error de la terminal y ofrecer "Nueva sesión". |
| El backend se reinicia con sesiones vivas | Sesiones "Detenida", retomables. |
| Dos pestañas del navegador en la misma tarea | Ambas ven la misma pty (RF4/WS). |
| Fichero con el mismo nombre en `.task/` | Sufijo `-2`, `-3`… |
| `.task/` aparece en el índice de git | Bloquear el push (RF6). |

---

## 13. Plan de implementación por fases

**Fase 0 — Spike y verificación del entorno** (parar y reportar)

- Script `server/scripts/env-check.ts` que verifique los puntos de la sección 15 en un repo de prueba temporal.
- Prueba mínima: lanzar `claude --version` y luego `claude` interactivo con `node-pty` en Windows y ver la salida en un xterm.js básico.
- Entregable: informe de qué funciona y qué no, con alternativas.

**Fase 1 — Backend de repos y tareas**

- `TaskStore`, `GitService`, rutas de repos y tareas, creación de worktree (RF1, RF2 sin documentos ni sesión), cierre (RF7) y reconciliación (RF9).
- Tests de `GitService` con repos temporales: crear tarea con base no principal, rama existente local y remota, cierre con y sin cambios.

**Fase 2 — Terminal y sesiones**

- `PtyManager`, WebSocket, `SessionService` (RF4) y shell (RF8).
- Frontend mínimo: sidebar más terminal funcional.

**Fase 3 — Documentos**

- RF3 completo: drag & drop, inserción `@` y prompt inicial con referencias.

**Fase 4 — Git y PR**

- RF5 (badges, pestaña Git) y RF6 (push, URL del PR).

**Fase 5 — Pulido**

- Reconexión con buffer, estados `Esperando`, notificaciones, atajos, Ajustes y `/env/check` en la UI.

---

## 14. Criterios de aceptación (prueba manual de extremo a extremo)

1. Registro un repo cuya base de trabajo es `origin/develop` (no `main`).
2. Creo `PROJ-1` con rama `feature/PROJ-1` desde `origin/develop` y adjunto `funcional.pdf` → existe `.claude/worktrees/PROJ-1` en `feature/PROJ-1`, con `git merge-base` igual a la punta de `origin/develop`, y `.task/funcional.pdf` no aparece en `git status`.
3. Inicio sesión → veo Claude Code en el navegador y el prompt inicial escrito con `@.task/funcional.pdf`. Pulso Enter y Claude lee el PDF.
4. Claude me hace una pregunta con opciones → la respondo con el teclado desde el navegador.
5. Creo `PROJ-2` en el mismo repo e inicio su sesión mientras `PROJ-1` sigue trabajando. Vuelvo a `PROJ-1` y su terminal sigue viva con todo el historial.
6. Recargo la página → ambas terminales se restauran.
7. Paro el backend, lo arranco de nuevo y pulso "Retomar" en `PROJ-1` → Claude continúa la misma conversación.
8. Arrastro `notas.md` a `PROJ-1` → se guarda en `.task/` y con un clic se inserta `@.task/notas.md` en el prompt.
9. Push → la rama remota es `feature/PROJ-1`. "Abrir PR" abre la URL con destino `develop`.
10. Cierro `PROJ-2` con cambios sin commitear → me avisa y exige confirmación; tras confirmar, el worktree desaparece de `git worktree list`.
11. Desde una terminal normal, `claude --resume <sessionId>` (dentro del worktree de la tarea) abre la misma conversación: el panel no es imprescindible.

---

## 15. Supuestos a verificar en la Fase 0

| # | Supuesto | Cómo verificar | Plan B |
|---|---|---|---|
| 1 | Existe el flag `--session-id <uuid>` | `claude --help` | Tras iniciar, leer el id de la sesión más reciente del directorio de transcripts de Claude Code, o retomar con `claude --worktree <clave> --continue` / el selector de `--resume`. |
| 2 | `claude --worktree <clave>` reutiliza un worktree creado antes con `git worktree add` en `.claude/worktrees/<clave>`, sin cambiar la rama | Crear el worktree desde `develop`, lanzar Claude y ejecutar `git branch --show-current` dentro | Lanzar `claude` con cwd = worktree (sin `--worktree`). |
| 3 | `--worktree <clave> --resume <id>` funciona | Iniciar, salir conservando el worktree y retomar | `--resume <id>` sin `--worktree`. |
| 4 | Claude Code resuelve `@.task/x.pdf` escrito en el prompt y lee PDFs | Prueba manual | Prompt explícito: "Lee el fichero .task/x.pdf". |
| 5 | `node-pty` se instala y funciona en esta máquina Windows con `claude` | `npm i node-pty` y prueba de la Fase 0 | `@lydell/node-pty` u otro fork con binarios precompilados. |
| 6 | `.git/info/exclude` del directorio común aplica a todos los worktrees | `git status` en el worktree con un fichero en `.task/` | Activar `git config extensions.worktreeConfig true` y, en cada worktree, `git config --worktree core.excludesFile <fichero con .task/>`. |

Referencia: documentación oficial de worktrees en Claude Code — https://code.claude.com/docs/en/worktrees

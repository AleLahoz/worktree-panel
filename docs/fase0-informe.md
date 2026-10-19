# Fase 0 — Informe del spike

Entorno: Windows 11, git 2.53.0, Claude Code 2.1.303 (`C:\Users\aleja\.local\bin\claude.exe`).

## Resultados

| # | Supuesto | Resultado | Notas |
|---|---|---|---|
| 1 | Flag `--session-id` | OK | También `--worktree` y `--resume` en `claude --help`. |
| 2 | `claude --worktree <clave>` reutiliza worktree existente | **PARCIAL / PROBLEMA** | Reutiliza el worktree y la rama `feature/T-1` (probado: `git branch --show-current` = `feature/T-1`). Pero ver "Hallazgos graves". |
| 3 | `--worktree <clave> --resume <id>` | **FALLO de diseño** | La conversación se retoma (recordó el dato), pero el worktree se recrea en otra rama. Ver abajo. |
| 4 | `@.task/x.md` resuelto | OK | Para `.md`. PDF sin probar. |
| 5 | node-pty en Windows con claude | OK | `node-pty` oficial, sin Build Tools. |
| 6 | `info/exclude` común aplica a worktrees | OK | `git status` limpio con `.task/x.md`. |
| - | Worktree desde `origin/develop` con `--no-track` | OK | `merge-base` = punta de develop; sin upstream. |

## Hallazgos graves (cambian el diseño de las Fases 1-2)

1. **El diálogo de confianza NO aparece con `--worktree`.** Sale con código 1:
   `Error creating worktree: Workspace trust not yet accepted. Run claude once in this directory and accept the trust dialog, then retry with --worktree.`
   La spec (§9.3) asumía que se vería en la terminal. El panel debe lanzar antes `claude` a secas en la raíz del repo la primera vez.
2. **Al salir de Claude (`/exit`), si no hay cambios rastreados, borra el worktree entero** ("Removing worktree… Worktree removed (no changes)"), **incluida `.task/`** (ignorada por git, no cuenta como cambio). La rama se conserva. Se pierde toda la documentación de la tarea.
3. **`--worktree T-1 --resume <id>` tras ese borrado recrea `T-1` en una rama nueva `worktree-T-1` desde `main`** (no `feature/T-1` ni develop) y bloqueado (`locked`). Se rompe el requisito de la rama/base elegidas.

Plan B de la spec (§15 puntos 2 y 3), **sin probar aún** pero que evita los tres problemas: lanzar `claude --session-id <id>` / `claude --resume <id>` con cwd = el worktree, sin `--worktree`. Hay que verificar que el resume funciona desde ahí (la spec §9.2 advierte que puede rechazarse) y que no se borra nada al salir.

## Otros hallazgos
- **Entorno heredado**: si el panel se arranca desde una sesión de Claude, el pty hereda `CLAUDECODE`, `CLAUDE_CODE_*` y `CLAUDE_PID`, y Claude desactiva los transcripts (imposible `--resume`). `SessionService` debe filtrarlas al lanzar.
- **node-pty lanza excepción** al hacer `resize`/`write` sobre un pty ya terminado y tumba el proceso: `PtyManager` debe ignorarlos tras `exit`.
- La terminal xterm necesita foco (clic) antes de recibir teclado.

## Avisos
- `core.longpaths` no está a `true`. Recomendado: `git config --global core.longpaths true` (no se cambia automáticamente).
- La instalación de Node 24.13.1 de fnm no incluye npm. Se trabajó con Node 25.8.2. Reinstalar: `fnm install 24 --force`.

## Cómo reproducir
- `npm run env-check` (desde la raíz).
- `node node_modules/tsx/dist/cli.mjs server/scripts/pty-spike.ts [ruta-repo-ya-confiado]`, abrir `http://127.0.0.1:4318/?mode=start` y luego `?mode=resume`.

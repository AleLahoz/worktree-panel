# Fase 0 — Informe del spike

Entorno: Windows 11, git 2.53.0, Claude Code 2.1.303 (`C:\Users\aleja\.local\bin\claude.exe`).

## Resultados

| # | Supuesto | Resultado | Notas |
|---|---|---|---|
| 1 | Flag `--session-id` | OK | También `--worktree` y `--resume` en `claude --help`. |
| 5 | node-pty en Windows con claude | OK | `node-pty` oficial se instala sin Build Tools; ConPTY lanza `claude.exe --version`. No hace falta fork. |
| 6 | `info/exclude` común aplica a worktrees | OK | `git status` limpio con `.task/x.md` en el worktree. |
| - | Worktree desde `origin/develop` con `--no-track` | OK | `merge-base` = punta de develop; sin upstream. |
| 2 | `claude --worktree <clave>` reutiliza worktree existente | PENDIENTE (manual) | `npm run pty-spike -w server`, abrir `/?mode=start`. |
| 3 | `--worktree <clave> --resume <id>` | PENDIENTE (manual) | Mismo spike, `/?mode=resume`. |
| 4 | `@.task/x.md` resuelto por Claude | PENDIENTE (manual) | El spike crea `.task/notas.md` con una palabra secreta. |

## Avisos
- `core.longpaths` no está a `true`. Recomendado: `git config --global core.longpaths true` (no se cambia automáticamente).
- La instalación de Node 24.13.1 de fnm no incluye npm (`npm-prefix.js` ausente). Se trabajó con Node 25.8.2 (npm 11.11.1). Conviene reinstalar: `fnm install 24 --force` o usar otra versión por defecto.

## Cómo reproducir
- `npm run env-check` (desde la raíz).
- `npm run pty-spike -w server` y abrir `http://127.0.0.1:4318/?mode=start`; salir de Claude, abrir `?mode=resume`.
  Al terminar cada proceso, la consola del servidor imprime la rama del worktree y `git worktree list`.

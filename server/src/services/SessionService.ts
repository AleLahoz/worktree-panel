import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { Task } from "../types.js";
import type { ManagedPty, PtyKind, PtyManager, PtyStatus } from "./PtyManager.js";
import type { TaskStore } from "./TaskStore.js";

const execFileP = promisify(execFile);

export type SessionState = "none" | PtyStatus;

export interface SessionStates {
  claude: SessionState;
  shell: SessionState;
}

/** Variables que Claude Code inyecta en su entorno: si se heredan, desactiva los transcripts (y con ellos --resume). */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Comando y argumentos para lanzar `claude`: los .cmd/.bat pasan por cmd.exe. */
export function claudeCommand(claudePath: string, args: string[]): { file: string; args: string[] } {
  return /\.(cmd|bat)$/i.test(claudePath) ? { file: "cmd.exe", args: ["/d", "/s", "/c", claudePath, ...args] } : { file: claudePath, args };
}

export function renderPrompt(template: string, task: Task, docs: string[]): string {
  const vars: Record<string, string> = {
    key: task.key,
    title_suffix: task.title ? ` (${task.title})` : "",
    branch: task.branch,
    base: task.prBase,
    doc_refs: docs.length ? docs.map((d) => `@.task/${d}`).join(" ") : "(sin documentos)",
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export interface SessionTimings {
  /** Silencio tras la primera salida para considerar a Claude listo. */
  readyQuietMs: number;
  /** Si no está listo a los N ms, no se escribe nada. */
  readyTimeoutMs: number;
  /** Espera tras el primer Ctrl+C. */
  secondInterruptMs: number;
  /** Tras este tiempo sin salir, se mata el proceso. */
  stopGraceMs: number;
}
const DEFAULT_TIMINGS: SessionTimings = { readyQuietMs: 1500, readyTimeoutMs: 15000, secondInterruptMs: 300, stopGraceMs: 5000 };

export class SessionService {
  constructor(
    private ptys: PtyManager,
    private store: TaskStore,
    private getConfig: () => Promise<AppConfig>,
    private timings: SessionTimings = DEFAULT_TIMINGS,
  ) {}

  states(taskId: string, task?: Task): SessionStates {
    const state = (kind: PtyKind): SessionState => this.ptys.status(taskId, kind) ?? (kind === "claude" && task?.sessionId ? "stopped" : "none");
    return { claude: state("claude"), shell: state("shell") };
  }

  async resolveClaudePath(): Promise<string> {
    const config = await this.getConfig();
    if (config.claudePath) return config.claudePath;
    try {
      const { stdout } = await execFileP(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true });
      const first = stdout.split(/\r?\n/).find(Boolean);
      if (first) return first.trim();
    } catch {
      /* no está en el PATH */
    }
    throw new AppError(424, "claude_not_found", "Claude Code no está instalado o no está en el PATH (configura la ruta en Ajustes)");
  }

  private async spawnClaude(task: Task, args: string[]): Promise<ManagedPty> {
    if (this.ptys.isAlive(task.id, "claude")) throw new AppError(409, "session_running", "La sesión de Claude ya está en marcha");
    const cmd = claudeCommand(await this.resolveClaudePath(), args);
    // cwd = worktree y sin --worktree: con --worktree Claude borra el worktree (y .task/) al salir sin cambios y,
    // al retomar, lo recrea en otra rama. Verificado en la Fase 0.
    return this.ptys.spawn(task.id, "claude", { ...cmd, cwd: task.worktreePath, env: cleanEnv() });
  }

  /** Lee los documentos de .task/ (para las referencias @ del prompt inicial). */
  async docNames(task: Task): Promise<string[]> {
    try {
      return (await readdir(path.join(task.worktreePath, ".task"), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  async initialPrompt(task: Task): Promise<string> {
    return renderPrompt((await this.getConfig()).initialPromptTemplate, task, await this.docNames(task));
  }

  /** Escribe el prompt inicial (sin Enter) en la pty de Claude. */
  async writeInitialPrompt(task: Task): Promise<void> {
    const pty = this.ptys.get(task.id, "claude");
    if (!pty || pty.exited) throw new AppError(409, "no_session", "No hay una sesión de Claude en marcha");
    pty.write(await this.initialPrompt(task));
  }

  /** Cuando la terminal muestra salida y se queda estable ~1,5 s, escribe el prompt; si no llega a los 15 s, no hace nada. */
  private scheduleInitialPrompt(task: Task, pty: ManagedPty) {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pty.exited || Date.now() - started > this.timings.readyTimeoutMs) return clearInterval(timer);
      if (pty.hasOutput && Date.now() - pty.lastOutputAt >= this.timings.readyQuietMs) {
        clearInterval(timer);
        this.writeInitialPrompt(task).catch(() => {});
      }
    }, 100);
    timer.unref();
  }

  async startClaude(task: Task, opts: { initialPrompt?: boolean } = {}): Promise<Task> {
    const sessionId = randomUUID();
    const pty = await this.spawnClaude(task, ["--session-id", sessionId]);
    const saved = await this.store.saveTask({ ...task, sessionId });
    if (opts.initialPrompt !== false) this.scheduleInitialPrompt(saved, pty);
    return saved;
  }

  async resumeClaude(task: Task): Promise<void> {
    if (!task.sessionId) throw new AppError(400, "no_session_id", "La tarea no tiene una sesión que retomar");
    await this.spawnClaude(task, ["--resume", task.sessionId]);
  }

  /** Ctrl+C dos veces; si sigue vivo a los 5 s, se mata. No borra nada. */
  async stop(taskId: string, kind: PtyKind): Promise<void> {
    const pty = this.ptys.get(taskId, kind);
    if (!pty || pty.exited) return;
    pty.write("\x03");
    await new Promise((r) => setTimeout(r, this.timings.secondInterruptMs));
    pty.write("\x03");
    if (!(await pty.waitForExit(this.timings.stopGraceMs))) {
      pty.kill();
      await pty.waitForExit(2000);
    }
  }

  /** Escribe en la pty de Claude sin Enter (referencias `@.task/...`). */
  insert(taskId: string, text: string): void {
    const pty = this.ptys.get(taskId, "claude");
    if (!pty || pty.exited) throw new AppError(409, "no_session", "No hay una sesión de Claude en marcha");
    pty.write(text);
  }

  async startShell(task: Task, initialCommand?: string): Promise<void> {
    if (this.ptys.isAlive(task.id, "shell")) throw new AppError(409, "shell_running", "La shell ya está abierta");
    const config = await this.getConfig();
    const pty = this.ptys.spawn(task.id, "shell", {
      file: config.shellPath,
      args: /pwsh|powershell/i.test(config.shellPath) ? ["-NoLogo"] : [],
      cwd: task.worktreePath,
      env: cleanEnv(),
    });
    if (initialCommand) setTimeout(() => pty.write(`${initialCommand}\r`), 500).unref();
  }

  /** Para cerrar una tarea: mata ptys y espera, porque en Windows no se puede borrar un directorio que es cwd de un proceso. */
  async killTask(taskId: string): Promise<void> {
    await this.ptys.killTask(taskId);
  }
}

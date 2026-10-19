import { createRequire } from "node:module";

export type PtyKind = "claude" | "shell";
export type PtyStatus = "running" | "waiting" | "stopped";

/** Subconjunto de node-pty que usamos (permite inyectar un falso en tests). */
export interface RawPty {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type SpawnFn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => RawPty;

export interface PtyClient {
  send(msg: ServerMessage): void;
}
export type ServerMessage =
  | { t: "out"; d: string }
  | { t: "exit"; code: number }
  | { t: "status"; s: PtyStatus };

export interface SpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyOptions {
  spawn?: SpawnFn;
  bufferChars?: number;
  /** Sin salida durante este tiempo => "waiting". */
  idleMs?: number;
  flushMs?: number;
  now?: () => number;
}

const realSpawn: SpawnFn = (file, args, opts) => {
  const nodePty = createRequire(import.meta.url)("node-pty");
  return nodePty.spawn(file, args, { name: "xterm-256color", ...opts });
};

/** Una pseudo-terminal viva (o ya terminada) con buffer de salida y clientes conectados. */
export class ManagedPty {
  private chunks: string[] = [];
  private size = 0;
  private pending = "";
  private flushTimer?: NodeJS.Timeout;
  private clients = new Set<PtyClient>();
  private lastStatus: PtyStatus = "running";
  private exitWaiters: (() => void)[] = [];
  lastOutputAt: number;
  exited = false;
  exitCode?: number;
  cols: number;
  rows: number;

  constructor(
    readonly taskId: string,
    readonly kind: PtyKind,
    private raw: RawPty,
    private opts: Required<Pick<PtyOptions, "bufferChars" | "idleMs" | "flushMs" | "now">>,
    size: { cols: number; rows: number },
  ) {
    this.cols = size.cols;
    this.rows = size.rows;
    this.lastOutputAt = opts.now();
    raw.onData((d) => this.handleData(d));
    raw.onExit((e) => this.handleExit(e.exitCode));
  }

  get pid() {
    return this.raw.pid;
  }

  /** ¿Ha producido ya alguna salida? */
  get hasOutput() {
    return this.size > 0;
  }

  /** Últimos `n` caracteres de la salida (para detectar diálogos sin interferir con la terminal). */
  tail(n: number): string {
    return this.chunks.join("").slice(-n);
  }

  status(): PtyStatus {
    if (this.exited) return "stopped";
    return this.opts.now() - this.lastOutputAt > this.opts.idleMs ? "waiting" : "running";
  }

  private handleData(d: string) {
    this.lastOutputAt = this.opts.now();
    this.chunks.push(d);
    this.size += d.length;
    while (this.size > this.opts.bufferChars && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
    if (this.size > this.opts.bufferChars) {
      const only = this.chunks[0];
      this.chunks[0] = only.slice(only.length - this.opts.bufferChars);
      this.size = this.chunks[0].length;
    }
    this.pending += d;
    this.flushTimer ??= setTimeout(() => this.flush(), this.opts.flushMs);
    this.refreshStatus();
  }

  /** Envía a los clientes la salida acumulada en un solo mensaje (lotes de ~16 ms). */
  private flush() {
    this.flushTimer = undefined;
    if (!this.pending) return;
    const d = this.pending;
    this.pending = "";
    this.broadcast({ t: "out", d });
  }

  private handleExit(code: number) {
    this.exited = true;
    this.exitCode = code;
    clearTimeout(this.flushTimer);
    this.flush();
    this.broadcast({ t: "exit", code });
    this.refreshStatus();
    this.exitWaiters.splice(0).forEach((fn) => fn());
  }

  /** Emite "status" si ha cambiado (también lo llama el reloj del manager). */
  refreshStatus() {
    const s = this.status();
    if (s !== this.lastStatus) {
      this.lastStatus = s;
      this.broadcast({ t: "status", s });
    }
  }

  private broadcast(msg: ServerMessage) {
    for (const c of this.clients) {
      try {
        c.send(msg);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  /** Conecta un cliente: recibe primero el buffer acumulado y después la salida en vivo. */
  attach(client: PtyClient) {
    this.flush(); // lo pendiente ya forma parte del buffer
    const buffered = this.chunks.join("");
    if (buffered) client.send({ t: "out", d: buffered });
    if (this.exited) client.send({ t: "exit", code: this.exitCode ?? 0 });
    client.send({ t: "status", s: this.status() });
    this.clients.add(client);
  }

  detach(client: PtyClient) {
    this.clients.delete(client);
  }

  /** Ignorado si el proceso ya terminó (node-pty lanzaría una excepción que tumba el servidor). */
  write(data: string): boolean {
    if (this.exited) return false;
    this.raw.write(data);
    return true;
  }

  resize(cols: number, rows: number) {
    if (this.exited || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.raw.resize(cols, rows);
    } catch {
      /* el proceso acaba de terminar */
    }
  }

  kill() {
    if (!this.exited) this.raw.kill();
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  dispose() {
    clearTimeout(this.flushTimer);
  }
}

/** Ptys por tarea: como mucho una de cada tipo ("claude" | "shell"). */
export class PtyManager {
  private ptys = new Map<string, ManagedPty>();
  private opts: Required<Pick<PtyOptions, "bufferChars" | "idleMs" | "flushMs" | "now">>;
  private spawnFn: SpawnFn;
  private clock: NodeJS.Timeout;

  constructor(options: PtyOptions = {}) {
    this.spawnFn = options.spawn ?? realSpawn;
    this.opts = { bufferChars: options.bufferChars ?? 1_000_000, idleMs: options.idleMs ?? 3000, flushMs: options.flushMs ?? 16, now: options.now ?? Date.now };
    this.clock = setInterval(() => this.ptys.forEach((p) => p.refreshStatus()), 1000);
    this.clock.unref();
  }

  private key = (taskId: string, kind: PtyKind) => `${taskId}:${kind}`;

  get(taskId: string, kind: PtyKind): ManagedPty | undefined {
    return this.ptys.get(this.key(taskId, kind));
  }

  /** Estado, o undefined si nunca hubo pty en esta ejecución del backend. */
  status(taskId: string, kind: PtyKind): PtyStatus | undefined {
    return this.get(taskId, kind)?.status();
  }

  isAlive(taskId: string, kind: PtyKind): boolean {
    const p = this.get(taskId, kind);
    return !!p && !p.exited;
  }

  spawn(taskId: string, kind: PtyKind, o: SpawnOptions): ManagedPty {
    if (this.isAlive(taskId, kind)) throw new Error(`Ya hay una pty ${kind} viva para la tarea ${taskId}`);
    const cols = o.cols ?? 120;
    const rows = o.rows ?? 30;
    const raw = this.spawnFn(o.file, o.args, { cwd: o.cwd, env: o.env ?? (process.env as Record<string, string>), cols, rows });
    const managed = new ManagedPty(taskId, kind, raw, this.opts, { cols, rows });
    this.get(taskId, kind)?.dispose();
    this.ptys.set(this.key(taskId, kind), managed);
    return managed;
  }

  /** Mata las ptys de la tarea y espera a que terminen (necesario en Windows antes de borrar el directorio). */
  async killTask(taskId: string, timeoutMs = 5000): Promise<void> {
    const mine = (["claude", "shell"] as const).map((k) => this.get(taskId, k)).filter((p): p is ManagedPty => !!p && !p.exited);
    mine.forEach((p) => p.kill());
    await Promise.all(mine.map((p) => p.waitForExit(timeoutMs)));
  }

  async killAll(): Promise<void> {
    const ids = new Set([...this.ptys.values()].map((p) => p.taskId));
    await Promise.all([...ids].map((id) => this.killTask(id)));
    clearInterval(this.clock);
  }
}

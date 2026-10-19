import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { saveConfig, DEFAULT_CONFIG } from "../src/config.js";
import { createContext, type AppContext } from "../src/context.js";
import type { RawPty } from "../src/services/PtyManager.js";
import { claudeCommand, cleanEnv, isTrustDialogShowing, renderPrompt } from "../src/services/SessionService.js";
import type { Task } from "../src/types.js";
import { attachWebSocket } from "../src/ws.js";
import { createFixture, type Fixture } from "./fixture.js";

class FakePty implements RawPty {
  pid = 42;
  written: string[] = [];
  killed = false;
  private dataCb: (d: string) => void = () => {};
  private exitCb: (e: { exitCode: number }) => void = () => {};
  constructor(public file: string, public args: string[], public opts: { cwd: string; env: Record<string, string> }) {}
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); }
  resize() {}
  kill() { this.killed = true; setTimeout(() => this.exit(0), 5); }
  emit(d: string) { this.dataCb(d); }
  exit(code = 0) { this.exitCb({ exitCode: code }); }
}

let fx: Fixture;
let ctx: AppContext;
let spawned: FakePty[];
let task: Task;
const FAST = { readyQuietMs: 50, readyTimeoutMs: 600, secondInterruptMs: 10, stopGraceMs: 80, trustDialogWaitMs: 5000 };

beforeEach(async () => {
  fx = createFixture();
  spawned = [];
  await saveConfig({ ...DEFAULT_CONFIG, claudePath: "C:\\fake\\claude.exe", shellPath: "powershell.exe" }, fx.dataDir);
  ctx = createContext(fx.dataDir, 4317, {
    timings: FAST,
    pty: { spawn: (file, args, opts) => { const p = new FakePty(file, args, opts); spawned.push(p); return p; } },
  });
  const repo = await ctx.service.addRepo(fx.repo, { defaultBase: "origin/develop" });
  task = (await ctx.service.createTask({ repoId: repo.id, key: "PROJ-1", title: "Tasas", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } })).task;
  writeFileSync(path.join(task.worktreePath, ".task", "funcional.pdf"), "pdf");
});
afterEach(async () => {
  await ctx.ptys.killAll();
  await fx.cleanup();
});

describe("funciones puras", () => {
  it("cleanEnv quita los marcadores de Claude Code y conserva el resto", () => {
    const env = cleanEnv({ PATH: "p", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_PID: "9", CLAUDE_CONFIG_DIR: "keep", HOME: "h" });
    expect(env).toEqual({ PATH: "p", CLAUDE_CONFIG_DIR: "keep", HOME: "h" });
  });

  it("claudeCommand envuelve .cmd con cmd.exe y deja .exe tal cual", () => {
    expect(claudeCommand("C:\\x\\claude.cmd", ["--resume", "id"])).toEqual({ file: "cmd.exe", args: ["/d", "/s", "/c", "C:\\x\\claude.cmd", "--resume", "id"] });
    expect(claudeCommand("C:\\x\\claude.exe", ["--resume", "id"])).toEqual({ file: "C:\\x\\claude.exe", args: ["--resume", "id"] });
  });

  it("isTrustDialogShowing distingue el diálogo en pantalla del ya aceptado", () => {
    const dialog = "Quick safety check\r\n\x1b[36m> No, exit\x1b[0m\r\n  Yes, I trust this folder\r\nEnter to confirm · Esc to cancel";
    expect(isTrustDialogShowing(dialog)).toBe(true);
    expect(isTrustDialogShowing(dialog + "\x1b[2J Claude Code v2.1.303\r\n")).toBe(false);
    expect(isTrustDialogShowing("Claude Code v2")).toBe(false);
  });

  it("renderPrompt rellena la plantilla", () => {
    const t = { key: "K-1", title: "Tasas", branch: "feature/K-1", prBase: "develop" } as Task;
    const out = renderPrompt("{key}{title_suffix} {branch} {base} {doc_refs} {otra}", t, ["a.pdf", "b.md"]);
    expect(out).toBe("K-1 (Tasas) feature/K-1 develop @.task/a.pdf @.task/b.md {otra}");
    expect(renderPrompt("{doc_refs}", { ...t, title: undefined } as Task, [])).toBe("(sin documentos)");
  });
});

describe("sesión de Claude", () => {
  it("start: cwd = worktree, sin --worktree, con --session-id, entorno limpio y sessionId guardado", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "heredada";
    const saved = await ctx.sessions.startClaude(task);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const p = spawned[0];
    expect(p.file).toBe("C:\\fake\\claude.exe");
    expect(p.args).toEqual(["--session-id", saved.sessionId]);
    expect(p.args).not.toContain("--worktree");
    expect(p.opts.cwd).toBe(task.worktreePath);
    expect(Object.keys(p.opts.env).filter((k) => k.startsWith("CLAUDE_CODE_"))).toEqual([]);
    expect((await ctx.store.getTask(task.id)).sessionId).toBe(saved.sessionId);
    expect(saved.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("escribe el prompt inicial sin Enter cuando la salida se estabiliza, con las referencias @", async () => {
    await ctx.sessions.startClaude(task);
    const p = spawned[0];
    await new Promise((r) => setTimeout(r, 120));
    expect(p.written).toEqual([]); // sin salida aún: no escribe
    p.emit("Claude Code v2");
    await vi.waitFor(() => expect(p.written).toHaveLength(1), { timeout: 2000 });
    const prompt = p.written[0];
    expect(prompt).toContain("tarea PROJ-1 (Tasas)");
    expect(prompt).toContain("feature/PROJ-1");
    expect(prompt).toContain("@.task/funcional.pdf");
    expect(prompt).not.toMatch(/[\r\n]$/);
  });

  it("no escribe el prompt mientras el diálogo de confianza siga en pantalla y lo escribe al aceptarlo", async () => {
    await ctx.sessions.startClaude(task);
    const p = spawned[0];
    p.emit("\x1b[1mQuick safety check\x1b[0m\r\n> No, exit\r\n  Yes, I trust this folder\r\nEnter to confirm");
    await new Promise((r) => setTimeout(r, 900)); // más que readyTimeoutMs: seguiría esperando por el diálogo
    expect(p.written).toEqual([]);
    p.emit("[2J" + "Claude Code v2 ".repeat(40)); // el usuario aceptó y Claude redibuja
    await vi.waitFor(() => expect(p.written).toHaveLength(1), { timeout: 2000 });
  });

  it("si Claude no queda estable en el plazo, no escribe nada (queda el botón manual)", async () => {
    await ctx.sessions.startClaude(task);
    const p = spawned[0];
    const keepBusy = setInterval(() => p.emit("."), 20); // nunca se estabiliza
    await new Promise((r) => setTimeout(r, 800));
    clearInterval(keepBusy);
    expect(p.written).toEqual([]);
    await ctx.sessions.writeInitialPrompt(task);
    expect(p.written).toHaveLength(1);
  });

  it("resume usa --resume con el sessionId y exige que exista", async () => {
    await expect(ctx.sessions.resumeClaude(task)).rejects.toMatchObject({ code: "no_session_id" });
    const saved = await ctx.sessions.startClaude(task, { initialPrompt: false });
    spawned[0].exit(0);
    await ctx.sessions.resumeClaude(saved);
    expect(spawned[1].args).toEqual(["--resume", saved.sessionId]);
    expect(spawned[1].opts.cwd).toBe(task.worktreePath);
  });

  it("no permite dos sesiones vivas", async () => {
    await ctx.sessions.startClaude(task, { initialPrompt: false });
    await expect(ctx.sessions.startClaude(task)).rejects.toMatchObject({ code: "session_running" });
  });

  it("estados: none -> running -> stopped (retomable)", async () => {
    expect(ctx.sessions.states(task.id, task).claude).toBe("none");
    const saved = await ctx.sessions.startClaude(task, { initialPrompt: false });
    expect(ctx.sessions.states(task.id, saved).claude).toBe("running");
    spawned[0].exit(0);
    expect(ctx.sessions.states(task.id, saved).claude).toBe("stopped");
    // tras reiniciar el backend no hay pty pero sí sessionId => "Detenida"
    const fresh = createContext(fx.dataDir, 4317);
    expect(fresh.sessions.states(task.id, saved).claude).toBe("stopped");
    expect(fresh.sessions.states(task.id, task).claude).toBe("none");
  });

  it("stop: Ctrl+C dos veces y mata si no sale en el plazo", async () => {
    await ctx.sessions.startClaude(task, { initialPrompt: false });
    const p = spawned[0];
    await ctx.sessions.stop(task.id, "claude");
    expect(p.written.filter((w) => w === "\x03")).toHaveLength(2);
    expect(p.killed).toBe(true);
    expect(ctx.ptys.isAlive(task.id, "claude")).toBe(false);
  });

  it("stop: si sale tras Ctrl+C no se mata", async () => {
    await ctx.sessions.startClaude(task, { initialPrompt: false });
    const p = spawned[0];
    const write = p.write.bind(p);
    p.write = (d) => { write(d); if (p.written.length === 2) p.exit(0); };
    await ctx.sessions.stop(task.id, "claude");
    expect(p.killed).toBe(false);
  });

  it("insert escribe el texto tal cual, sin Enter; sin sesión da error", async () => {
    expect(() => ctx.sessions.insert(task.id, "@.task/x.pdf ")).toThrow(/No hay una sesión/);
    await ctx.sessions.startClaude(task, { initialPrompt: false });
    ctx.sessions.insert(task.id, "@.task/x.pdf ");
    expect(spawned[0].written).toEqual(["@.task/x.pdf "]);
  });

  it("shell: powershell -NoLogo en el worktree y ejecuta el comando inicial", async () => {
    await ctx.sessions.startShell(task, "npm ci");
    const p = spawned[0];
    expect(p).toMatchObject({ file: "powershell.exe", args: ["-NoLogo"] });
    expect(p.opts.cwd).toBe(task.worktreePath);
    await vi.waitFor(() => expect(p.written).toEqual(["npm ci\r"]), { timeout: 2000 });
  });

  it("cerrar la tarea mata sus terminales antes de borrar el worktree", async () => {
    await ctx.sessions.startClaude(task, { initialPrompt: false });
    await ctx.sessions.startShell(task);
    await ctx.service.closeTask(task.id);
    expect(spawned.every((p) => p.killed)).toBe(true);
  });
});

describe("API de sesiones", () => {
  it("crear tarea con startSession inicia Claude y devuelve el estado; el listado incluye la sesión", async () => {
    const app = buildApp(ctx);
    const repo = (await ctx.store.listRepos())[0];
    const res = await app.inject({
      method: "POST", url: "/api/tasks", headers: { host: "127.0.0.1:4317" },
      payload: { repoId: repo.id, key: "PROJ-2", branch: { mode: "new", branch: "feature/PROJ-2", base: "origin/develop" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().session.claude).toBe("running");
    expect(res.json().task.sessionId).toBeTruthy();
    const list = await app.inject({ method: "GET", url: "/api/tasks", headers: { host: "127.0.0.1:4317" } });
    expect(list.json().find((t: Task) => t.key === "PROJ-2").session.claude).toBe("running");
    await app.close();
  });

  it("setupCommand abre la shell y falla de forma suave si Claude no está instalado", async () => {
    await saveConfig({ ...DEFAULT_CONFIG, claudePath: "", shellPath: "powershell.exe" }, fx.dataDir);
    const app = buildApp(ctx);
    const repo = (await ctx.store.listRepos())[0];
    await ctx.store.updateRepo(repo.id, { setupCommand: "npm ci" });
    const old = process.env.PATH;
    const where = process.platform === "win32" ? "where" : "which";
    const gitExe = execFileSync(where, ["git"], { encoding: "utf8" }).split(String.fromCharCode(10))[0].trim();
    process.env.PATH = path.dirname(gitExe); // git sí, claude no
    const res = await app.inject({
      method: "POST", url: "/api/tasks", headers: { host: "127.0.0.1:4317" },
      payload: { repoId: repo.id, key: "PROJ-3", branch: { mode: "new", branch: "feature/PROJ-3", base: "origin/develop" } },
    });
    process.env.PATH = old;
    expect(res.statusCode).toBe(201); // la tarea se crea igualmente
    expect(res.json().warnings.join(" ")).toMatch(/Claude/);
    expect(res.json().session).toMatchObject({ shell: "running" });
    await app.close();
  });
});

describe("WebSocket", () => {
  let app: ReturnType<typeof buildApp>;
  let port: number;
  beforeEach(async () => {
    app = buildApp({ ...ctx, port: 0 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
    ctx.port = port;
    attachWebSocket(app.server, ctx.ptys, port);
  });
  afterEach(() => app.close());

  const open = (urlPath: string, headers: Record<string, string> = {}) =>
    new Promise<{ ws: WebSocket; msgs: any[]; close: Promise<number> }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, { headers });
      const msgs: any[] = [];
      const close = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      ws.on("message", (m) => msgs.push(JSON.parse(String(m))));
      ws.on("open", () => resolve({ ws, msgs, close }));
      ws.on("error", reject);
    });

  it("recibe el buffer acumulado, la salida en vivo, y reenvía teclado y resize", async () => {
    await ctx.sessions.startClaude(task, { initialPrompt: false });
    spawned[0].emit("historial ");
    const { ws, msgs } = await open(`/ws/pty/${task.id}/claude`);
    await vi.waitFor(() => expect(msgs.find((m) => m.t === "out")?.d).toBe("historial "));
    spawned[0].emit("vivo");
    await vi.waitFor(() => expect(msgs.filter((m) => m.t === "out").map((m) => m.d).join("")).toBe("historial vivo"));
    ws.send(JSON.stringify({ t: "in", d: "ls\r" }));
    await vi.waitFor(() => expect(spawned[0].written).toContain("ls\r"));
    ws.send("no es json");
    ws.send(JSON.stringify({ t: "resize", cols: "x", rows: 5 })); // inválido: se ignora
    ws.close();
  });

  it("dos clientes ven la misma pty (varias pestañas)", async () => {
    await ctx.sessions.startClaude(task, { initialPrompt: false });
    const a = await open(`/ws/pty/${task.id}/claude`);
    const b = await open(`/ws/pty/${task.id}/claude`);
    spawned[0].emit("hola");
    await vi.waitFor(() => {
      expect(a.msgs.some((m) => m.t === "out" && m.d.includes("hola"))).toBe(true);
      expect(b.msgs.some((m) => m.t === "out" && m.d.includes("hola"))).toBe(true);
    });
    a.ws.close();
    b.ws.close();
  });

  it("cierra con 4404 si no hay terminal y rechaza orígenes ajenos", async () => {
    const none = await open(`/ws/pty/${task.id}/claude`);
    expect(await none.close).toBe(4404);
    await expect(open(`/ws/pty/${task.id}/claude`, { Origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(open(`/otra/ruta`)).rejects.toThrow(/403/);
  });
});

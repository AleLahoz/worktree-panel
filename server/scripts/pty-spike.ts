// Spike Fase 0: xterm.js en el navegador <-> pty con claude. Solo 127.0.0.1.
// Uso: npm run pty-spike -w server -- [cwd] [args de claude...]
//   cwd por defecto: raíz del repo temporal creado en el arranque (develop como base).
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const PORT = 4318;
const webRoot = path.resolve(import.meta.dirname, "..", "..", "node_modules", "@xterm");

const g = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

// Repo de prueba: main + develop, worktree T-1 desde develop, doc en .task/
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wtp-spike-")));
const repo = path.join(root, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-b", "main", repo]);
g(repo, "config", "user.email", "t@t.t");
g(repo, "config", "user.name", "t");
writeFileSync(path.join(repo, "a.txt"), "a");
g(repo, "add", ".");
g(repo, "commit", "-m", "init");
g(repo, "switch", "-c", "develop");
writeFileSync(path.join(repo, "b.txt"), "b");
g(repo, "add", ".");
g(repo, "commit", "-m", "develop");
g(repo, "switch", "main");
const common = path.resolve(repo, g(repo, "rev-parse", "--git-common-dir"));
writeFileSync(path.join(common, "info", "exclude"), ".claude/worktrees/\n.task/\n", { flag: "a" });
g(repo, "worktree", "add", "--no-track", "-b", "feature/T-1", path.join(".claude", "worktrees", "T-1"), "develop");
const wt = path.join(repo, ".claude", "worktrees", "T-1");
mkdirSync(path.join(wt, ".task"));
writeFileSync(path.join(wt, ".task", "notas.md"), "# Notas\nLa palabra secreta es PINGUINO.\n");

const sessionId = crypto.randomUUID();
const claudePath = execFileSync("where", ["claude"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const launch = (mode: "start" | "resume") => {
  const args = ["--worktree", "T-1", ...(mode === "start" ? ["--session-id", sessionId] : ["--resume", sessionId])];
  return claudePath.toLowerCase().endsWith(".cmd")
    ? { file: "cmd.exe", args: ["/d", "/s", "/c", claudePath, ...args] }
    : { file: claudePath, args };
};

console.log(`Repo de prueba: ${repo}\nWorktree:       ${wt}\nsessionId:      ${sessionId}`);
console.log(`Abre http://127.0.0.1:${PORT}/?mode=start  (y luego ?mode=resume)`);

const html = readFileSync(path.join(import.meta.dirname, "spike.html"), "utf8");
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (u.pathname === "/") { res.setHeader("content-type", "text/html"); return void res.end(html); }
  const map: Record<string, string> = {
    "/xterm.js": "xterm/lib/xterm.js", "/xterm.css": "xterm/css/xterm.css",
    "/fit.js": "addon-fit/lib/addon-fit.js",
  };
  const f = map[u.pathname];
  if (!f) { res.statusCode = 404; return void res.end(); }
  res.setHeader("content-type", f.endsWith(".css") ? "text/css" : "text/javascript");
  res.end(readFileSync(path.join(webRoot, f)));
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return void ws.close();
  const mode = new URL(req.url ?? "", "http://x").searchParams.get("mode") === "resume" ? "resume" : "start";
  const l = launch(mode);
  const p = pty.spawn(l.file, l.args, { name: "xterm-256color", cols: 120, rows: 30, cwd: repo });
  p.onData((d: string) => ws.send(JSON.stringify({ t: "out", d })));
  p.onExit((e: { exitCode: number }) => {
    ws.send(JSON.stringify({ t: "exit", code: e.exitCode }));
    execFile("git", ["-C", wt, "branch", "--show-current"], (_e, out) => console.log(`[${mode}] rama en worktree: ${out.trim()}`));
    execFile("git", ["-C", repo, "worktree", "list", "--porcelain"], (_e, out) => console.log(out));
  });
  ws.on("message", (m) => {
    const msg = JSON.parse(String(m));
    if (msg.t === "in") p.write(msg.d);
    else if (msg.t === "resize") p.resize(msg.cols, msg.rows);
  });
  ws.on("close", () => p.kill());
});
server.listen(PORT, "127.0.0.1");

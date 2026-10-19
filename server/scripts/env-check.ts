import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const run = promisify(execFile);

type Status = "OK" | "FALLO" | "MANUAL" | "AVISO";
interface Check {
  id: string;
  name: string;
  status: Status;
  detail: string;
}
const results: Check[] = [];
const add = (id: string, name: string, status: Status, detail: string) =>
  results.push({ id, name, status, detail });

async function cmd(file: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run(file, args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}
const git = (cwd: string, ...args: string[]) =>
  cmd("git", ["-C", cwd, "-c", "core.quotepath=off", ...args]);

async function tryCmd(file: string, args: string[]): Promise<string | null> {
  try {
    return await cmd(file, args);
  } catch {
    return null;
  }
}

async function main() {
  // Versiones
  const gitV = await tryCmd("git", ["--version"]);
  add("env-git", "git", gitV ? "OK" : "FALLO", gitV ?? "git no encontrado");
  add("env-node", "node", "OK", process.version);

  const where = await tryCmd(process.platform === "win32" ? "where" : "which", ["claude"]);
  const claudePath = where?.split(/\r?\n/)[0];
  const claudeV = claudePath ? await tryCmd(claudePath, ["--version"]) : null;
  add("env-claude", "claude", claudeV ? "OK" : "FALLO", claudePath ? `${claudePath} (${claudeV})` : "no está en el PATH");

  // Supuesto 1: flags
  if (claudePath) {
    const help = (await tryCmd(claudePath, ["--help"])) ?? "";
    const flags = ["--session-id", "--worktree", "--resume"];
    const missing = flags.filter((f) => !help.includes(f));
    add("1", "flag --session-id (y --worktree, --resume)", missing.length ? "FALLO" : "OK", missing.length ? `faltan: ${missing.join(", ")}` : "presentes en claude --help");
  } else {
    add("1", "flags de claude", "FALLO", "claude no disponible");
  }

  // Supuesto 5: node-pty
  try {
    const require = createRequire(import.meta.url);
    const pty = require("node-pty");
    if (claudePath) {
      const out = await new Promise<string>((resolve, reject) => {
        const p = pty.spawn(claudePath, ["--version"], { cols: 100, rows: 30 });
        let buf = "";
        const t = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 15000);
        p.onData((d: string) => (buf += d));
        p.onExit(() => { clearTimeout(t); resolve(buf); });
      });
      add("5", "node-pty + claude", /Claude Code/.test(out) ? "OK" : "FALLO", "ConPTY lanzó claude --version");
    } else {
      add("5", "node-pty", "OK", "carga, sin claude para probar");
    }
  } catch (e) {
    add("5", "node-pty", "FALLO", String(e));
  }

  // core.longpaths
  const lp = await tryCmd("git", ["config", "--get", "core.longpaths"]);
  add("env-longpaths", "core.longpaths", lp === "true" ? "OK" : "AVISO",
    lp === "true" ? "true" : "no está a true: recomendado `git config --global core.longpaths true`");

  // Supuestos 6 y base: repo temporal con remoto simulado
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "wtp-envcheck-")));
  try {
    const bare = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    await mkdir(repo);
    await cmd("git", ["init", "--bare", "-b", "main", bare]);
    await cmd("git", ["init", "-b", "main", repo]);
    await git(repo, "config", "user.email", "t@t.t");
    await git(repo, "config", "user.name", "t");
    await git(repo, "remote", "add", "origin", bare);
    await writeFile(path.join(repo, "a.txt"), "a");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    await git(repo, "switch", "-c", "develop");
    await writeFile(path.join(repo, "b.txt"), "b");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "develop");
    await git(repo, "push", "origin", "main", "develop");
    await git(repo, "switch", "main");
    await git(repo, "fetch", "--prune", "origin");

    const common = path.resolve(repo, await git(repo, "rev-parse", "--git-common-dir"));
    await mkdir(path.join(common, "info"), { recursive: true });
    await writeFile(path.join(common, "info", "exclude"), ".claude/worktrees/\n.task/\n", { flag: "a" });

    const wt = path.join(repo, ".claude", "worktrees", "T-1");
    await git(repo, "worktree", "add", "--no-track", "-b", "feature/T-1", path.join(".claude", "worktrees", "T-1"), "origin/develop");
    await mkdir(path.join(wt, ".task"));
    await writeFile(path.join(wt, ".task", "x.md"), "doc");

    const status = await git(wt, "status", "--porcelain=v1");
    add("6", "info/exclude común aplica a worktrees", status === "" ? "OK" : "FALLO", status === "" ? "status limpio con .task/x.md presente" : `status: ${status}`);

    const mb = await git(wt, "merge-base", "HEAD", "origin/develop");
    const tip = await git(repo, "rev-parse", "origin/develop");
    add("base", "worktree sale de origin/develop (no de main)", mb === tip ? "OK" : "FALLO", `merge-base ${mb.slice(0, 7)} / develop ${tip.slice(0, 7)}`);

    const mainTracked = await tryCmd("git", ["-C", wt, "rev-parse", "--abbrev-ref", "@{u}"]);
    add("no-track", "--no-track: sin upstream", mainTracked === null ? "OK" : "FALLO", mainTracked ?? "sin upstream");
  } catch (e) {
    add("6", "repo temporal", "FALLO", String(e));
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  // Supuestos que requieren Claude interactivo (cuenta del usuario): pty-spike
  add("2", "claude --worktree reutiliza worktree existente", "MANUAL", "probar con `npm run pty-spike -w server`");
  add("3", "--worktree <clave> --resume <id>", "MANUAL", "probar con pty-spike");
  add("4", "@.task/x.pdf resuelto y PDF legible", "MANUAL", "probar con pty-spike");

  for (const r of results) console.log(`[${r.status.padEnd(6)}] ${r.id.padEnd(14)} ${r.name} — ${r.detail}`);
  console.log("\n" + JSON.stringify(results, null, 2));
  process.exit(results.some((r) => r.status === "FALLO") ? 1 : 0);
}

main();

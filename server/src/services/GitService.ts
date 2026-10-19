import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, appendFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { GitStatus } from "../types.js";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Ejecuta git con args en array (nunca por shell). No lanza si git sale con error. */
function run(cwd: string | undefined, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") return reject(err); // ENOENT, etc.
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trim(), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
      },
    );
  });
}

/** Ejecuta git y devuelve stdout; si falla lanza AppError con el stderr. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run(cwd, args);
  if (r.code !== 0) throw new AppError(500, "git_failed", `git ${args[0]} falló: ${r.stderr || r.stdout}`, { args, stderr: r.stderr });
  return r.stdout;
}

const ok = async (cwd: string, ...args: string[]) => (await run(cwd, args)).code === 0;

export const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const REMOVE_ATTEMPTS = 8;
const BUSY_DIR = /permission denied|failed to delete|being used by another process|resource busy|directory not empty/i;

export interface WorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
  locked: boolean;
  /** git lo registra pero su directorio ya no existe (borrado a mano). */
  missing: boolean;
}

export interface Branches {
  local: string[];
  remote: string[];
}

export type ChangeKind = "untracked" | "modified" | "added" | "deleted" | "renamed" | "conflict";

export interface FileChange {
  path: string;
  /** Ruta anterior (renombrados). */
  orig?: string;
  /** Código de dos letras de `git status --porcelain` (XY). */
  code: string;
  kind: ChangeKind;
  staged: boolean;
  unstaged: boolean;
}

export interface FileDiff {
  file: string;
  staged: string;
  unstaged: string;
  truncated: boolean;
}

const MAX_DIFF_CHARS = 400_000;

export type BranchMode = { mode: "new"; branch: string; base: string } | { mode: "existing"; branch: string; base?: string };

const norm = (p: string) => path.resolve(p).toLowerCase();

export const GitService = {
  /** Raíz real del checkout; lanza si no es un repo git. */
  async repoRoot(p: string): Promise<string> {
    const r = await run(p, ["rev-parse", "--show-toplevel"]);
    if (r.code !== 0) throw new AppError(400, "not_a_repo", `"${p}" no es un checkout git`);
    return path.resolve(r.stdout);
  },

  /** Añade a <git-common-dir>/info/exclude las líneas que falten. No toca el .gitignore del equipo. */
  async ensureExcluded(repo: string, lines = [".claude/worktrees/", ".task/"]): Promise<void> {
    const common = path.resolve(repo, await git(repo, "rev-parse", "--git-common-dir"));
    const file = path.join(common, "info", "exclude");
    await mkdir(path.dirname(file), { recursive: true });
    let current = "";
    try {
      current = await readFile(file, "utf8");
    } catch {
      /* no existe aún */
    }
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = lines.filter((l) => !have.has(l));
    if (missing.length) await appendFile(file, (current && !current.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
  },

  /** Devuelve null si va bien o el mensaje de error (para tolerar fallos de red). */
  async fetch(repo: string, prune = false): Promise<string | null> {
    const r = await run(repo, ["fetch", ...(prune ? ["--prune"] : []), "origin"]);
    return r.code === 0 ? null : r.stderr || "git fetch falló";
  },

  async remotes(repo: string): Promise<string[]> {
    const out = await git(repo, "remote");
    return out ? out.split(/\r?\n/) : [];
  },

  async branches(repo: string): Promise<Branches> {
    const list = async (ns: string) => {
      const out = await git(repo, "for-each-ref", "--format=%(refname:short)", ns);
      return out ? out.split(/\r?\n/) : [];
    };
    const remote = (await list("refs/remotes")).filter((b) => !b.endsWith("/HEAD") && b.includes("/"));
    return { local: await list("refs/heads"), remote };
  },

  async isValidBranchName(repo: string, name: string): Promise<boolean> {
    return ok(repo, "check-ref-format", "--branch", name);
  },

  localBranchExists: (repo: string, b: string) => ok(repo, "show-ref", "--verify", "--quiet", `refs/heads/${b}`),
  remoteBranchExists: (repo: string, b: string) => ok(repo, "show-ref", "--verify", "--quiet", `refs/remotes/${b}`),
  refExists: (repo: string, ref: string) => ok(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`),

  async listWorktrees(repo: string): Promise<WorktreeInfo[]> {
    const out = await git(repo, "worktree", "list", "--porcelain");
    const infos = out
      .split(/\r?\n\r?\n/)
      .filter(Boolean)
      .map((block) => {
        const info: WorktreeInfo = { path: "", locked: false, missing: false };
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("worktree ")) info.path = path.resolve(line.slice(9));
          else if (line.startsWith("HEAD ")) info.head = line.slice(5);
          else if (line.startsWith("branch ")) info.branch = line.slice(7).replace(/^refs\/heads\//, "");
          else if (line === "locked" || line.startsWith("locked ")) info.locked = true;
        }
        return info;
      });
    for (const w of infos) w.missing = !(await stat(w.path).then(() => true, () => false));
    return infos;
  },

  /** Quita el prefijo de remoto ("origin/develop" -> "develop") para usarlo como destino del PR. */
  async stripRemote(repo: string, ref: string): Promise<string> {
    for (const remote of await this.remotes(repo)) if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
    return ref;
  },

  /**
   * Crea el worktree de una tarea en <repo>/.claude/worktrees/<key>.
   * Devuelve la rama final y la base efectiva (baseRef/prBase).
   */
  async addWorktree(repo: string, key: string, spec: BranchMode, fallbackBase?: string) {
    if (!KEY_RE.test(key)) throw new AppError(400, "invalid_key", "La clave solo admite [A-Za-z0-9._-] (máx. 64)");
    const wtPath = path.join(repo, ".claude", "worktrees", key);
    if (await stat(wtPath).then(() => true, () => false)) {
      throw new AppError(409, "worktree_dir_exists", `El directorio ${wtPath} ya existe`, { path: wtPath });
    }
    const relPath = path.join(".claude", "worktrees", key);
    const worktrees = await this.listWorktrees(repo);
    const inUse = (branch: string) => worktrees.find((w) => w.branch === branch);

    if (spec.mode === "new") {
      if (!(await this.isValidBranchName(repo, spec.branch))) throw new AppError(400, "invalid_branch", `Nombre de rama no válido: ${spec.branch}`);
      if (await this.localBranchExists(repo, spec.branch)) {
        throw new AppError(409, "branch_exists", `La rama ${spec.branch} ya existe`, { branch: spec.branch, canUseExisting: true });
      }
      const remotes = await this.remotes(repo);
      for (const rm of remotes) {
        if (await this.remoteBranchExists(repo, `${rm}/${spec.branch}`)) {
          throw new AppError(409, "branch_exists", `La rama ${rm}/${spec.branch} ya existe en el remoto`, { branch: spec.branch, canUseExisting: true });
        }
      }
      if (!(await this.refExists(repo, spec.base))) throw new AppError(400, "base_not_found", `La rama base ${spec.base} no existe`);
      await git(repo, "worktree", "add", "--no-track", "-b", spec.branch, relPath, spec.base);
      return { branch: spec.branch, baseRef: spec.base, prBase: await this.stripRemote(repo, spec.base), worktreePath: wtPath };
    }

    // existente: local ("x") o solo remota ("origin/x")
    let branch = spec.branch;
    let remoteRef: string | undefined;
    if (!(await this.localBranchExists(repo, branch))) {
      if (!(await this.remoteBranchExists(repo, branch))) throw new AppError(400, "branch_not_found", `La rama ${branch} no existe`);
      remoteRef = branch;
      branch = await this.stripRemote(repo, branch);
      if (await this.localBranchExists(repo, branch)) remoteRef = undefined; // ya hay copia local con ese nombre
    }
    const other = inUse(branch);
    if (other) throw new AppError(409, "branch_in_use", `La rama ${branch} ya está en uso en el worktree ${other.path}`, { path: other.path });

    if (remoteRef) await git(repo, "worktree", "add", "--track", "-b", branch, relPath, remoteRef);
    else await git(repo, "worktree", "add", relPath, branch);

    const baseRef = spec.base ?? fallbackBase;
    if (!baseRef) throw new AppError(400, "base_required", "Indica la rama base (el repo no tiene defaultBase)");
    return { branch, baseRef, prBase: await this.stripRemote(repo, baseRef), worktreePath: wtPath };
  },

  /**
   * Copia a `worktree` los ficheros ignorados por git que listen los patrones de <repo>/.worktreeinclude
   * (mismo criterio que Claude Code: coincidir con el fichero Y estar ignorados).
   */
  async copyWorktreeInclude(repo: string, worktree: string): Promise<string[]> {
    const includeFile = path.join(repo, ".worktreeinclude");
    if (!(await stat(includeFile).then(() => true, () => false))) return [];
    const list = async (...extra: string[]) => {
      const out = (await run(repo, ["ls-files", "-z", "--others", "--ignored", ...extra])).stdout;
      return out.split("\0").filter(Boolean);
    };
    const ignored = new Set(await list("--exclude-standard"));
    const matching = await list(`--exclude-from=${includeFile}`);
    const copied: string[] = [];
    for (const rel of matching.filter((f) => ignored.has(f))) {
      const dest = path.join(worktree, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(repo, rel), dest);
      copied.push(rel);
    }
    return copied;
  },

  async status(worktree: string, baseRef: string): Promise<GitStatus> {
    const branch = (await run(worktree, ["branch", "--show-current"])).stdout;
    const porcelain = (await run(worktree, ["status", "--porcelain=v1", "-uall"])).stdout;
    const changedFiles = porcelain ? porcelain.split(/\r?\n/).length : 0;
    const count = async (range: string) => {
      const r = await run(worktree, ["rev-list", "--count", range]);
      return r.code === 0 ? Number(r.stdout) : 0;
    };
    const hasUpstream = (await run(worktree, ["rev-parse", "--abbrev-ref", "@{u}"])).code === 0;
    const unpushed = hasUpstream ? await count("@{u}..HEAD") : await count(`${baseRef}..HEAD`);
    const behindBase = await count(`HEAD..${baseRef}`);
    const log = (await run(worktree, ["log", "-1", "--format=%h%x09%s%x09%cr"])).stdout;
    const [hash, subject, relative] = log.split("\t");
    return { branch, baseRef, changedFiles, unpushed, behindBase, hasUpstream, lastCommit: hash ? { hash, subject, relative } : undefined };
  },

  /** Ficheros con cambios (índice, directorio de trabajo y sin seguimiento). */
  async changes(worktree: string): Promise<FileChange[]> {
    // -uall: lista cada fichero sin seguimiento en vez de colapsar el directorio entero.
    const out = (await run(worktree, ["status", "--porcelain=v1", "-uall", "-z"])).stdout;
    const tokens = out.split("\0").filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const change: FileChange = { path: entry.slice(3), code, kind: "modified", staged: false, unstaged: false };
      if (code[0] === "R" || code[0] === "C") change.orig = tokens[++i];
      const [x, y] = code;
      if (code === "??") change.kind = "untracked";
      else if (x === "U" || y === "U" || code === "AA" || code === "DD") change.kind = "conflict";
      else if (x === "R" || x === "C") change.kind = "renamed";
      else if (x === "A") change.kind = "added";
      else if (x === "D" || y === "D") change.kind = "deleted";
      change.staged = x !== " " && x !== "?";
      change.unstaged = y !== " " && y !== "?";
      changes.push(change);
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  },

  /**
   * Diff de un fichero con cambios: lo staged (`git diff --cached`), lo no staged (`git diff`)
   * y, si es nuevo, su contenido completo como adición. Solo acepta ficheros que aparecen en `changes()`.
   */
  async diff(worktree: string, file: string): Promise<FileDiff> {
    const change = (await this.changes(worktree)).find((c) => c.path === file);
    if (!change) throw new AppError(404, "file_not_changed", `${file} no tiene cambios`);
    const cap = (text: string) => (text.length > MAX_DIFF_CHARS ? { text: text.slice(0, MAX_DIFF_CHARS), cut: true } : { text, cut: false });

    let staged = { text: "", cut: false };
    let unstaged = { text: "", cut: false };
    if (change.kind === "untracked") {
      // --no-index sale con código 1 cuando hay diferencias: es lo normal.
      unstaged = cap((await run(worktree, ["diff", "--no-index", "--no-color", "--", "/dev/null", file])).stdout);
    } else {
      staged = cap((await run(worktree, ["diff", "--cached", "--no-color", "--", file])).stdout);
      unstaged = cap((await run(worktree, ["diff", "--no-color", "--", file])).stdout);
    }
    return { file, staged: staged.text, unstaged: unstaged.text, truncated: staged.cut || unstaged.cut };
  },

  /** `git push -u origin <rama>`; devuelve la salida (git escribe el progreso en stderr). */
  async push(worktree: string, branch: string): Promise<string> {
    const r = await run(worktree, ["push", "-u", "origin", branch]);
    const output = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (r.code !== 0) throw new AppError(502, "push_failed", `git push falló:\n${output}`, { output });
    return output;
  },

  /** Ficheros de .task/ presentes en el índice (nunca deben subirse). */
  async trackedTaskFiles(worktree: string): Promise<string[]> {
    const out = await git(worktree, "ls-files", ".task");
    return out ? out.split(/\r?\n/) : [];
  },

  /** Quita el worktree; si está bloqueado hace unlock y reintenta. `force` descarta cambios. */
  async removeWorktree(repo: string, worktreePath: string, force: boolean): Promise<void> {
    const args = ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath];
    let r = await run(repo, args);
    for (let attempt = 1; r.code !== 0 && attempt <= REMOVE_ATTEMPTS; attempt++) {
      if (/locked/i.test(r.stderr)) {
        await run(repo, ["worktree", "unlock", worktreePath]);
      } else if (/not a working tree/i.test(r.stderr)) {
        // git ya lo desregistró en un intento anterior pero no pudo borrar el directorio.
        await this.removeLeftoverDir(repo, worktreePath);
        r = { ...r, code: 0 };
        break;
      } else if (BUSY_DIR.test(r.stderr)) {
        // En Windows el directorio sigue "en uso" un instante tras terminar los procesos que lo tenían como cwd.
        await new Promise((res) => setTimeout(res, 400 * attempt));
      } else break;
      r = await run(repo, args);
    }
    if (r.code !== 0) throw new AppError(409, "worktree_remove_failed", `No se pudo eliminar el worktree: ${r.stderr}`);
    await run(repo, ["worktree", "prune"]);
  },

  /**
   * Borra el directorio de un worktree que git ya no registra (p. ej. tras un borrado a medias).
   * Solo actúa dentro de <repo>/.claude/worktrees/, nunca fuera.
   */
  async removeLeftoverDir(repo: string, dir: string): Promise<void> {
    const base = norm(path.join(repo, ".claude", "worktrees")) + path.sep;
    if (!norm(dir).startsWith(base)) throw new AppError(400, "unsafe_path", `${dir} no está dentro de .claude/worktrees`);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch((e: Error) => {
      throw new AppError(409, "worktree_remove_failed", `No se pudo borrar el directorio ${dir}: ${e.message}`);
    });
  },

  async deleteBranch(repo: string, branch: string, force: boolean): Promise<void> {
    const r = await run(repo, ["branch", force ? "-D" : "-d", branch]);
    if (r.code !== 0) throw new AppError(409, "branch_delete_failed", `No se pudo borrar la rama ${branch}: ${r.stderr}`, { notMerged: /not fully merged/i.test(r.stderr) });
  },

  async prune(repo: string): Promise<void> {
    await run(repo, ["worktree", "prune"]);
  },

  async remoteUrl(repo: string, remote = "origin"): Promise<string | null> {
    const r = await run(repo, ["remote", "get-url", remote]);
    return r.code === 0 ? r.stdout : null;
  },

  norm,
  run,
};

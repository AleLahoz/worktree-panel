import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { GitService } from "../src/services/GitService.js";
import { createFixture, git, type Fixture } from "./fixture.js";

let fx: Fixture;
let repoId: string;

beforeEach(async () => {
  fx = createFixture();
  repoId = (await fx.service.addRepo(fx.repo, { defaultBase: "origin/develop" })).id;
});
afterEach(() => fx.cleanup());

const expectError = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
};

describe("repos", () => {
  it("rechaza rutas que no son repos git", async () => {
    await expectError(fx.service.addRepo(fx.root), "not_a_repo");
  });

  it("añade .claude/worktrees/ y .task/ a info/exclude sin tocar .gitignore y sin duplicar", async () => {
    await GitService.ensureExcluded(fx.repo);
    const exclude = path.join(fx.repo, ".git", "info", "exclude");
    const text = (await import("node:fs")).readFileSync(exclude, "utf8");
    expect(text.match(/\.task\//g)).toHaveLength(1);
    expect(text.match(/\.claude\/worktrees\//g)).toHaveLength(1);
    expect(existsSync(path.join(fx.repo, ".gitignore"))).toBe(false);
  });

  it("no permite registrar el mismo repo dos veces", async () => {
    await expectError(fx.service.addRepo(fx.repo), "repo_exists");
  });
});

describe("crear tarea", () => {
  it("nueva rama desde una base que no es main: merge-base = punta de origin/develop, sin upstream", async () => {
    const { task } = await fx.service.createTask({ repoId, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } });
    expect(task.branch).toBe("feature/PROJ-1");
    expect(task.baseRef).toBe("origin/develop");
    expect(task.prBase).toBe("develop");
    expect(git(task.worktreePath, "branch", "--show-current")).toBe("feature/PROJ-1");
    expect(git(task.worktreePath, "merge-base", "HEAD", "origin/develop")).toBe(git(fx.repo, "rev-parse", "origin/develop"));
    expect(() => git(task.worktreePath, "rev-parse", "--abbrev-ref", "@{u}")).toThrow(); // --no-track
    expect(git(fx.repo, "branch", "--show-current")).toBe("main"); // no toca el checkout principal
  });

  it("copia documentos a .task/ y no aparecen en git status", async () => {
    const doc = path.join(fx.root, "funcional.pdf");
    writeFileSync(doc, "pdf");
    const { task } = await fx.service.createTask({
      repoId, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" },
      docs: [{ name: "funcional.pdf", path: doc }],
    });
    expect(existsSync(path.join(task.worktreePath, ".task", "funcional.pdf"))).toBe(true);
    expect(git(task.worktreePath, "status", "--porcelain")).toBe("");
  });

  it("usa una rama local existente", async () => {
    const { task } = await fx.service.createTask({ repoId, key: "REL", branch: { mode: "existing", branch: "release/x", base: "origin/main" } });
    expect(task.branch).toBe("release/x");
    expect(task.prBase).toBe("main");
    expect(git(task.worktreePath, "branch", "--show-current")).toBe("release/x");
  });

  it("usa una rama solo remota creando la local con tracking", async () => {
    const { task } = await fx.service.createTask({ repoId, key: "RO", branch: { mode: "existing", branch: "origin/feature/remote-only" } });
    expect(task.branch).toBe("feature/remote-only");
    expect(task.baseRef).toBe("origin/develop"); // defaultBase del repo
    expect(git(task.worktreePath, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/feature/remote-only");
  });

  it("falla si la rama nueva ya existe (local o remota) y sugiere usar la existente", async () => {
    const local = await expectError(
      fx.service.createTask({ repoId, key: "A", branch: { mode: "new", branch: "develop", base: "origin/main" } }), "branch_exists");
    expect((local.details as { canUseExisting: boolean }).canUseExisting).toBe(true);
    await expectError(
      fx.service.createTask({ repoId, key: "B", branch: { mode: "new", branch: "feature/remote-only", base: "origin/main" } }), "branch_exists");
  });

  it("falla si la base no existe y no deja worktree a medias", async () => {
    await expectError(fx.service.createTask({ repoId, key: "A", branch: { mode: "new", branch: "feature/A", base: "origin/nope" } }), "base_not_found");
    expect(existsSync(path.join(fx.repo, ".claude", "worktrees", "A"))).toBe(false);
    expect(await fx.store.listTasks()).toHaveLength(0);
  });

  it("valida la clave y el nombre de rama", async () => {
    await expectError(fx.service.createTask({ repoId, key: "../evil", branch: { mode: "new", branch: "x", base: "origin/develop" } }), "invalid_key");
    await expectError(fx.service.createTask({ repoId, key: "A", branch: { mode: "new", branch: "mala..rama", base: "origin/develop" } }), "invalid_branch");
  });

  it("claves duplicadas en el mismo repo", async () => {
    await fx.service.createTask({ repoId, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } });
    await expectError(fx.service.createTask({ repoId, key: "proj-1", branch: { mode: "new", branch: "feature/otra", base: "origin/develop" } }), "task_exists");
  });

  it("rama existente ya usada en otro worktree: indica en cuál", async () => {
    const { task } = await fx.service.createTask({ repoId, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } });
    const err = await expectError(fx.service.createTask({ repoId, key: "OTRA", branch: { mode: "existing", branch: "feature/PROJ-1", base: "origin/develop" } }), "branch_in_use");
    expect(GitService.norm((err.details as { path: string }).path)).toBe(GitService.norm(task.worktreePath));
  });

  it("copia a la tarea los ficheros ignorados listados en .worktreeinclude (y solo esos)", async () => {
    writeFileSync(path.join(fx.repo, ".gitignore"), ".env\nsecret.txt\nbuild/\n");
    writeFileSync(path.join(fx.repo, ".worktreeinclude"), ".env\n");
    writeFileSync(path.join(fx.repo, ".env"), "A=1");
    writeFileSync(path.join(fx.repo, "secret.txt"), "no");
    mkdirSync(path.join(fx.repo, "build"));
    writeFileSync(path.join(fx.repo, "build", "out.js"), "no");
    git(fx.repo, "add", ".gitignore", ".worktreeinclude");
    git(fx.repo, "commit", "-m", "ignore");
    git(fx.repo, "push", "origin", "main");
    const { task } = await fx.service.createTask({ repoId, key: "ENV", branch: { mode: "new", branch: "feature/ENV", base: "origin/main" } });
    expect(existsSync(path.join(task.worktreePath, ".env"))).toBe(true);
    expect(existsSync(path.join(task.worktreePath, "secret.txt"))).toBe(false);
    expect(existsSync(path.join(task.worktreePath, "build"))).toBe(false);
  });
});

describe("estado git", () => {
  it("cuenta cambios, commits sin subir y por detrás de la base", async () => {
    const { task } = await fx.service.createTask({ repoId, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } });
    let st = await fx.service.status(task);
    expect(st).toMatchObject({ branch: "feature/PROJ-1", changedFiles: 0, unpushed: 0, behindBase: 0, hasUpstream: false });

    writeFileSync(path.join(task.worktreePath, "x.txt"), "x");
    writeFileSync(path.join(task.worktreePath, "ñandú.txt"), "x");
    git(task.worktreePath, "add", "x.txt");
    git(task.worktreePath, "commit", "-m", "uno");
    st = await fx.service.status(task);
    expect(st.changedFiles).toBe(1); // ñandú.txt sin commitear
    expect(st.unpushed).toBe(1); // sin upstream: respecto a la base
    expect(st.lastCommit?.subject).toBe("uno");

    git(task.worktreePath, "push", "-u", "origin", "feature/PROJ-1");
    expect((await fx.service.status(task)).unpushed).toBe(0);

    // la base avanza
    writeFileSync(path.join(fx.repo, "d.txt"), "d");
    git(fx.repo, "switch", "develop");
    git(fx.repo, "add", ".");
    git(fx.repo, "commit", "-m", "develop avanza");
    git(fx.repo, "push", "origin", "develop");
    git(fx.repo, "switch", "main");
    git(fx.repo, "fetch", "origin");
    expect((await fx.service.status(task)).behindBase).toBe(1);
  });
});

describe("cerrar tarea", () => {
  const newTask = () => fx.service.createTask({ repoId, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } });

  it("sin cambios: elimina el worktree (con .task/ dentro), archiva el JSON y conserva la rama", async () => {
    const { task } = await newTask();
    writeFileSync(path.join(task.worktreePath, ".task", "notas.md"), "n");
    // sin commits propios la rama no tiene nada sin subir respecto a la base
    const res = await fx.service.closeTask(task.id);
    expect(res.summary).toEqual({ dirty: 0, unpushed: 0 });
    expect(existsSync(task.worktreePath)).toBe(false);
    expect(git(fx.repo, "worktree", "list", "--porcelain")).not.toContain("PROJ-1");
    expect(git(fx.repo, "branch", "--list", "feature/PROJ-1")).toContain("feature/PROJ-1");
    expect(await fx.store.listTasks()).toHaveLength(0);
    expect(existsSync(path.join(fx.dataDir, "archive", `${task.id}.json`))).toBe(true);
  });

  it("con cambios sin commitear: exige force y detalla qué hay", async () => {
    const { task } = await newTask();
    writeFileSync(path.join(task.worktreePath, "wip.txt"), "wip");
    const err = await expectError(fx.service.closeTask(task.id), "unsaved_work");
    expect(err.details).toEqual({ dirty: 1, unpushed: 0 });
    expect(existsSync(task.worktreePath)).toBe(true); // no se tocó nada

    const res = await fx.service.closeTask(task.id, { force: true });
    expect(res.summary.dirty).toBe(1);
    expect(existsSync(task.worktreePath)).toBe(false);
  });

  it("con commits sin subir: exige force", async () => {
    const { task } = await newTask();
    writeFileSync(path.join(task.worktreePath, "c.txt"), "c");
    git(task.worktreePath, "add", ".");
    git(task.worktreePath, "commit", "-m", "local");
    const err = await expectError(fx.service.closeTask(task.id), "unsaved_work");
    expect(err.details).toEqual({ dirty: 0, unpushed: 1 });
  });

  it("borra la rama local: -d falla si no está fusionada, con force usa -D", async () => {
    const { task } = await newTask();
    writeFileSync(path.join(task.worktreePath, "c.txt"), "c");
    git(task.worktreePath, "add", ".");
    git(task.worktreePath, "commit", "-m", "local");
    await expectError(fx.service.closeTask(task.id, { deleteBranch: true }), "unsaved_work");
    await fx.service.closeTask(task.id, { force: true, deleteBranch: true });
    expect(git(fx.repo, "branch", "--list", "feature/PROJ-1")).toBe("");
  });

  it("desbloquea un worktree bloqueado", async () => {
    const { task } = await newTask();
    git(fx.repo, "worktree", "lock", task.worktreePath);
    await fx.service.closeTask(task.id);
    expect(existsSync(task.worktreePath)).toBe(false);
  });

  it("si el worktree ya no existe, permite cerrar y archivar", async () => {
    const { task } = await newTask();
    await (await import("node:fs/promises")).rm(task.worktreePath, { recursive: true, force: true });
    await fx.service.closeTask(task.id);
    expect(await fx.store.listTasks()).toHaveLength(0);
  });

  it("reintenta si el directorio sigue en uso (proceso con el worktree como cwd, típico de Windows)", async () => {
    const { task } = await newTask();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { cwd: task.worktreePath, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300)); // que el proceso ya esté arrancado dentro del directorio
    await fx.service.closeTask(task.id);
    holder.kill();
    expect(existsSync(task.worktreePath)).toBe(false);
    expect(git(fx.repo, "worktree", "list", "--porcelain")).not.toContain("PROJ-1");
    expect(await fx.store.listTasks()).toHaveLength(0);
  }, 40_000);

  it("al cerrar una tarea con worktree perdido borra el directorio sobrante de un borrado a medias", async () => {
    const { task } = await newTask();
    git(fx.repo, "worktree", "remove", "--force", task.worktreePath); // git lo desregistra...
    mkdirSync(path.join(task.worktreePath, ".task"), { recursive: true }); // ...pero queda el directorio
    writeFileSync(path.join(task.worktreePath, ".task", "notas.md"), "n");
    await fx.service.closeTask(task.id);
    expect(existsSync(task.worktreePath)).toBe(false);
  });

  it("nunca borra directorios fuera de .claude/worktrees", async () => {
    const { task } = await newTask();
    const outside = path.join(fx.root, "importante");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "x.txt"), "x");
    await fx.store.saveTask({ ...task, worktreePath: outside });
    await expectError(fx.service.closeTask(task.id), "unsafe_path");
    expect(existsSync(path.join(outside, "x.txt"))).toBe(true);
  });

  it("llama al gancho de cierre antes de borrar", async () => {
    const { task } = await newTask();
    let seen = false;
    fx.service.onBeforeClose = async (t) => { seen = existsSync(t.worktreePath); };
    await fx.service.closeTask(task.id);
    expect(seen).toBe(true);
  });
});

describe("reconciliar", () => {
  it("detecta worktrees perdidos y huérfanos, y permite importarlos", async () => {
    const { task } = await fx.service.createTask({ repoId, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } });
    git(fx.repo, "worktree", "add", "--no-track", "-b", "feature/manual", path.join(".claude", "worktrees", "MANUAL"), "origin/develop");
    await (await import("node:fs/promises")).rm(task.worktreePath, { recursive: true, force: true });

    const { lost, orphans } = await fx.service.reconcile();
    expect(lost.map((t) => t.key)).toEqual(["PROJ-1"]);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ key: "MANUAL", branch: "feature/manual" });

    const imported = await fx.service.importWorktree(repoId, "MANUAL");
    expect(imported).toMatchObject({ key: "MANUAL", branch: "feature/manual", baseRef: "origin/develop", prBase: "develop" });
    expect((await fx.service.reconcile()).orphans).toHaveLength(0);
  });
});

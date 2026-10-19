import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createContext, type AppContext } from "../src/context.js";
import { GitService } from "../src/services/GitService.js";
import type { Task } from "../src/types.js";
import { createFixture, git, type Fixture } from "./fixture.js";

const PORT = 4317;
let fx: Fixture;
let ctx: AppContext;
let app: FastifyInstance;
let task: Task;
let wt: string;
const put = (rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
  writeFileSync(path.join(wt, rel), content);
};
const call = (method: "GET" | "POST", url: string) => app.inject({ method, url: `/api${url}`, headers: { host: `127.0.0.1:${PORT}` } });

beforeEach(async () => {
  fx = createFixture();
  ctx = createContext(fx.dataDir, PORT);
  app = buildApp(ctx);
  const repo = await ctx.service.addRepo(fx.repo, { defaultBase: "origin/develop" });
  task = (await ctx.service.createTask({ repoId: repo.id, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } })).task;
  wt = task.worktreePath;
});
afterEach(async () => {
  await ctx.ptys.killAll();
  await app.close();
  await fx.cleanup();
});

describe("changes", () => {
  it("clasifica nuevos, modificados, borrados, renombrados y staged/no staged", async () => {
    put("c.txt", "contenido suficiente para que git detecte el renombrado\nlinea 2\nlinea 3\n");
    git(wt, "add", "c.txt");
    git(wt, "commit", "-m", "c");
    put("a.txt", "a cambiado"); // modificado sin staged (a.txt viene del commit inicial)
    put("nuevo.txt", "n"); // sin seguimiento
    put("staged.txt", "s");
    git(wt, "add", "staged.txt"); // añadido
    rmSync(path.join(wt, "b.txt")); // borrado (b.txt viene de develop)
    git(wt, "mv", "c.txt", "renombrado.txt");
    const byPath = Object.fromEntries((await GitService.changes(wt)).map((c) => [c.path, c]));
    expect(byPath["a.txt"]).toMatchObject({ kind: "modified", staged: false, unstaged: true });
    expect(byPath["nuevo.txt"]).toMatchObject({ kind: "untracked", code: "??" });
    expect(byPath["staged.txt"]).toMatchObject({ kind: "added", staged: true, unstaged: false });
    expect(byPath["b.txt"]).toMatchObject({ kind: "deleted", unstaged: true });
    expect(byPath["renombrado.txt"]).toMatchObject({ kind: "renamed", orig: "c.txt", staged: true });
  });

  it("no lista .task/ (está en info/exclude) y maneja nombres con acentos y espacios", async () => {
    put(".task/doc.md", "x");
    put("carpeta/ñandú con espacios.txt", "x");
    const paths = (await GitService.changes(wt)).map((c) => c.path);
    expect(paths).toEqual(["carpeta/ñandú con espacios.txt"]);
  });
});

describe("diff", () => {
  it("separa lo staged de lo no staged", async () => {
    put("a.txt", "primera\n");
    git(wt, "add", "a.txt");
    put("a.txt", "primera\nsegunda\n");
    const d = await GitService.diff(wt, "a.txt");
    expect(d.staged).toContain("+primera");
    expect(d.unstaged).toContain("+segunda");
    expect(d.unstaged).not.toContain("+primera");
    expect(d.truncated).toBe(false);
  });

  it("un fichero nuevo se muestra completo como adición", async () => {
    put("nuevo.txt", "linea 1\nlinea 2");
    const d = await GitService.diff(wt, "nuevo.txt");
    expect(d.unstaged).toContain("+linea 1");
    expect(d.unstaged).toContain("+linea 2");
    expect(d.unstaged).toContain("new file mode");
  });

  it("solo permite ficheros con cambios (no lee ficheros arbitrarios)", async () => {
    put("sin-cambios.txt", "x");
    git(wt, "add", ".");
    git(wt, "commit", "-m", "x");
    await expect(GitService.diff(wt, "sin-cambios.txt")).rejects.toMatchObject({ code: "file_not_changed" });
    await expect(GitService.diff(wt, "../../../etc/passwd")).rejects.toMatchObject({ code: "file_not_changed" });
    await expect(GitService.diff(wt, ".task/doc.md")).rejects.toMatchObject({ code: "file_not_changed" });
  });

  it("recorta diffs enormes", async () => {
    put("grande.txt", ("x".repeat(100) + "\n").repeat(6000));
    const d = await GitService.diff(wt, "grande.txt");
    expect(d.truncated).toBe(true);
    expect(d.unstaged.length).toBeLessThanOrEqual(400_000);
  });

  it("ficheros binarios no revientan", async () => {
    writeFileSync(path.join(wt, "img.bin"), Buffer.from([0, 1, 2, 0, 255, 254]));
    const d = await GitService.diff(wt, "img.bin");
    expect(d.unstaged).toMatch(/Binary files|GIT binary patch/);
  });
});

describe("push", () => {
  it("sube la rama con -u (upstream = origin/<rama>) y actualiza los commits sin subir", async () => {
    put("f.txt", "f");
    git(wt, "add", ".");
    git(wt, "commit", "-m", "trabajo");
    expect((await ctx.service.status(task)).unpushed).toBe(1);

    const out = await ctx.service.push(task);
    expect(out).toMatch(/feature\/PROJ-1/);
    expect(git(fx.origin, "branch", "--list", "feature/PROJ-1")).toContain("feature/PROJ-1");
    expect(git(wt, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/feature/PROJ-1");
    const st = await ctx.service.status(task);
    expect(st.unpushed).toBe(0);
    expect(st.hasUpstream).toBe(true);
  });

  it("bloquea el push si hay ficheros de .task/ en el índice y no sube nada", async () => {
    put(".task/secreto.pdf", "doc");
    git(wt, "add", "-f", ".task/secreto.pdf");
    git(wt, "commit", "-m", "oops");
    await expect(ctx.service.push(task)).rejects.toMatchObject({ code: "task_files_tracked", details: { files: [".task/secreto.pdf"] } });
    expect(git(fx.origin, "branch", "--list", "feature/PROJ-1")).toBe("");
  });

  it("devuelve la salida de git si el push falla", async () => {
    git(fx.repo, "remote", "set-url", "origin", path.join(fx.root, "no-existe.git"));
    const err = await ctx.service.push(task).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: "push_failed", status: 502 });
    expect(err.message).toMatch(/git push falló/);
  });

  it("falla de forma clara si el worktree ya no existe", async () => {
    rmSync(wt, { recursive: true, force: true });
    await expect(ctx.service.push(task)).rejects.toMatchObject({ code: "worktree_lost" });
  });
});

describe("API de git y PR", () => {
  it("files, diff y errores de validación", async () => {
    put("a.txt", "cambio");
    const files = (await call("GET", `/tasks/${task.id}/git/files`)).json();
    expect(files).toEqual([expect.objectContaining({ path: "a.txt", kind: "modified" })]);
    expect((await call("GET", `/tasks/${task.id}/git/diff?file=a.txt`)).json().unstaged).toContain("+cambio");
    expect((await call("GET", `/tasks/${task.id}/git/diff`)).statusCode).toBe(400);
    expect((await call("GET", `/tasks/${task.id}/git/diff?file=nada.txt`)).statusCode).toBe(404);
  });

  it("push y pr-url por API: el destino del PR es la base de la tarea (develop), no main", async () => {
    const push = await call("POST", `/tasks/${task.id}/git/push`);
    expect(push.statusCode).toBe(200);
    expect(git(fx.origin, "branch", "--list", "feature/PROJ-1")).toContain("feature/PROJ-1");

    git(fx.repo, "remote", "set-url", "origin", "git@github.com:org/repo.git");
    const pr = (await call("GET", `/tasks/${task.id}/pr-url`)).json();
    expect(pr).toEqual({ provider: "github", url: "https://github.com/org/repo/compare/develop...feature%2FPROJ-1?expand=1" });
  });

  it("pr-url con remoto desconocido usa la plantilla del repo y si no hay devuelve 422", async () => {
    git(fx.repo, "remote", "set-url", "origin", "git@git.interno.example:team/repo.git");
    const noTemplate = await call("GET", `/tasks/${task.id}/pr-url`);
    expect(noTemplate.statusCode).toBe(422);
    expect(noTemplate.json().error).toBe("provider_unknown");

    await ctx.store.updateRepo(task.repoId, { prUrlTemplate: "{web}/pr/new?from={branch}&into={base}" });
    expect((await call("GET", `/tasks/${task.id}/pr-url`)).json().url).toBe("https://git.interno.example/team/repo/pr/new?from=feature%2FPROJ-1&into=develop");
  });

  it("pr-url: un remoto local (ruta) no se entiende y se explica", async () => {
    const res = await call("GET", `/tasks/${task.id}/pr-url`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("remote_unsupported");
  });
});

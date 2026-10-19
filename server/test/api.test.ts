import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createFixture, type Fixture } from "./fixture.js";

const PORT = 4317;
let fx: Fixture;
let app: FastifyInstance;

beforeEach(() => {
  fx = createFixture();
  app = buildApp({ port: PORT, dataDir: fx.dataDir, store: fx.store, service: fx.service });
});
afterEach(async () => {
  await app.close();
  await fx.cleanup();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/api${url}`, payload: payload as object, headers: { host: `127.0.0.1:${PORT}`, ...headers } });

async function setup() {
  const repo = (await call("POST", "/repos", { path: fx.repo, defaultBase: "origin/develop" })).json();
  const res = await call("POST", "/tasks", { repoId: repo.id, key: "PROJ-1", title: "Tasas", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } });
  return { repo, res, task: res.json().task };
}

describe("seguridad", () => {
  it("rechaza Origin ajeno y Host que no sea local", async () => {
    expect((await call("GET", "/repos", undefined, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await call("GET", "/repos", undefined, { host: "evil.example" })).statusCode).toBe(403);
    expect((await call("GET", "/repos", undefined, { origin: `http://localhost:${PORT}` })).statusCode).toBe(200);
  });
});

describe("API de repos y tareas", () => {
  it("flujo completo: registrar repo, ramas, crear tarea, listar con estado, cerrar", async () => {
    const { repo, res, task } = await setup();
    expect(res.statusCode).toBe(201);
    expect(task).toMatchObject({ key: "PROJ-1", branch: "feature/PROJ-1", prBase: "develop" });

    const branches = (await call("GET", `/repos/${repo.id}/branches`)).json();
    expect(branches.local).toContain("develop");
    expect(branches.remote).toContain("origin/release/x");
    expect(branches.remote).not.toContain("origin/HEAD");

    const list = (await call("GET", "/tasks")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ lost: false, status: { branch: "feature/PROJ-1", changedFiles: 0 } });

    expect((await call("PATCH", `/tasks/${task.id}`, { prUrl: "https://example.com/pr/1" })).json().prUrl).toBe("https://example.com/pr/1");

    const closed = await call("POST", `/tasks/${task.id}/close`, {});
    expect(closed.statusCode).toBe(200);
    expect(existsSync(task.worktreePath)).toBe(false);
    expect((await call("GET", "/tasks")).json()).toHaveLength(0);
  });

  it("devuelve errores con código y estado HTTP útiles", async () => {
    const { repo } = await setup();
    const dup = await call("POST", "/tasks", { repoId: repo.id, key: "X", branch: { mode: "new", branch: "develop", base: "origin/main" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: "branch_exists", details: { canUseExisting: true } });

    const bad = await call("POST", "/tasks", { repoId: repo.id, key: "../x", branch: { mode: "new", branch: "a", base: "b" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_input");

    expect((await call("POST", "/repos", { path: fx.root })).json().error).toBe("not_a_repo");
    expect((await call("GET", "/tasks/nope")).statusCode).toBe(404);
  });

  it("cerrar con trabajo sin subir devuelve 409 y con force funciona", async () => {
    const { task } = await setup();
    (await import("node:fs")).writeFileSync(`${task.worktreePath}/wip.txt`, "x");
    const blocked = await call("POST", `/tasks/${task.id}/close`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "unsaved_work", details: { dirty: 1 } });
    expect((await call("POST", `/tasks/${task.id}/close`, { force: true })).statusCode).toBe(200);
  });

  it("reconcilia y archiva tareas con worktree perdido, pero no archiva las que existen", async () => {
    const { task } = await setup();
    expect((await call("POST", `/tasks/${task.id}/archive`)).statusCode).toBe(409);
    expect(existsSync(task.worktreePath)).toBe(true);

    await rm(task.worktreePath, { recursive: true, force: true });
    expect((await call("GET", "/tasks")).json()[0]).toMatchObject({ lost: true, status: null });
    expect((await call("GET", "/reconcile")).json().lost).toHaveLength(1);
    expect((await call("POST", `/tasks/${task.id}/archive`)).statusCode).toBe(204);
    expect((await call("GET", "/tasks")).json()).toHaveLength(0);
  });

  it("config y env/check", async () => {
    expect((await call("GET", "/config")).json()).toMatchObject({ port: 4317, shellPath: "powershell.exe" });
    const put = await call("PUT", "/config", { shellPath: "pwsh" });
    expect(put.json().shellPath).toBe("pwsh");
    expect((await call("GET", "/config")).json().shellPath).toBe("pwsh");
    const env = (await call("GET", "/env/check")).json();
    expect(env.git).toContain("git version");
    expect(env.node).toBe(process.version);
  });
});

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createContext, type AppContext } from "../src/context.js";
import { MAX_DOC_BYTES, sanitizeName, uniqueName } from "../src/services/DocService.js";
import type { Task } from "../src/types.js";
import { createFixture, git, type Fixture } from "./fixture.js";

const PORT = 4317;
let fx: Fixture;
let ctx: AppContext;
let app: FastifyInstance;
let task: Task;
let opened: string[];

beforeEach(async () => {
  fx = createFixture();
  opened = [];
  ctx = createContext(fx.dataDir, PORT, { opener: async (f) => void opened.push(f) });
  app = buildApp(ctx);
  const repo = await ctx.service.addRepo(fx.repo, { defaultBase: "origin/develop" });
  task = (await ctx.service.createTask({ repoId: repo.id, key: "PROJ-1", branch: { mode: "new", branch: "feature/PROJ-1", base: "origin/develop" } })).task;
});
afterEach(async () => {
  await ctx.ptys.killAll();
  await app.close();
  await fx.cleanup();
});

/** Construye un cuerpo multipart con el FormData nativo de Node. */
async function multipart(files: { name: string; data: string | Uint8Array }[]) {
  const fd = new FormData();
  for (const f of files) fd.append("file", new Blob([f.data]), f.name);
  const res = new Response(fd);
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { host: `127.0.0.1:${PORT}`, "content-type": res.headers.get("content-type")! } };
}
const upload = async (files: { name: string; data: string | Uint8Array }[]) => {
  const { payload, headers } = await multipart(files);
  return app.inject({ method: "POST", url: `/api/tasks/${task.id}/docs`, payload, headers });
};
const call = (method: "GET" | "DELETE" | "POST", url: string) => app.inject({ method, url: `/api${url}`, headers: { host: `127.0.0.1:${PORT}` } });
const docsDir = () => path.join(task.worktreePath, ".task");

describe("sanitizeName / uniqueName", () => {
  it("quita separadores de ruta y caracteres no válidos en Windows", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeName("C:\\Users\\x\\funcional.pdf")).toBe("funcional.pdf");
    expect(sanitizeName('a<b>c:d"e|f?g*h.md')).toBe("abcdefgh.md");
    expect(sanitizeName("informe v2 (final).pdf")).toBe("informe v2 (final).pdf");
    expect(sanitizeName("ñandú-é.md")).toBe("ñandú-é.md");
  });

  it("evita nombres vacíos, reservados de Windows y puntos o espacios finales", () => {
    expect(sanitizeName("")).toBe("archivo");
    expect(sanitizeName("..")).toBe("archivo");
    expect(sanitizeName("???")).toBe("archivo");
    expect(sanitizeName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeName("nul")).toBe("_nul");
    expect(sanitizeName("nota.md. ")).toBe("nota.md");
  });

  it("acorta nombres larguísimos conservando la extensión", () => {
    const out = sanitizeName("a".repeat(400) + ".pdf");
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("añade sufijo -2, -3… si el nombre ya existe", () => {
    const taken = new Set(["a.pdf", "a-2.pdf"]);
    expect(uniqueName("b.pdf", (n) => taken.has(n))).toBe("b.pdf");
    expect(uniqueName("a.pdf", (n) => taken.has(n))).toBe("a-3.pdf");
    expect(uniqueName("README", (n) => n === "README")).toBe("README-2");
  });
});

describe("API de documentos", () => {
  it("sube, lista y no aparece en git status", async () => {
    const res = await upload([{ name: "funcional.pdf", data: "%PDF-1.4 contenido" }, { name: "notas.md", data: "# notas" }]);
    expect(res.statusCode).toBe(201);
    expect(res.json().map((d: { name: string }) => d.name)).toEqual(["funcional.pdf", "notas.md"]);
    expect(res.json().every((d: { warning?: string }) => !d.warning)).toBe(true);
    expect(readFileSync(path.join(docsDir(), "funcional.pdf"), "utf8")).toBe("%PDF-1.4 contenido");

    const list = (await call("GET", `/tasks/${task.id}/docs`)).json();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: "funcional.pdf", size: 18 });
    expect(git(task.worktreePath, "status", "--porcelain")).toBe("");
  });

  it("renombra con sufijo si ya existe (sin distinguir mayúsculas, como Windows)", async () => {
    await upload([{ name: "notas.md", data: "1" }]);
    const res = await upload([{ name: "notas.md", data: "2" }, { name: "NOTAS.md", data: "3" }]);
    expect(res.json().map((d: { name: string }) => d.name)).toEqual(["notas-2.md", "NOTAS-3.md"]);
    expect(readdirSync(docsDir()).sort()).toEqual(["NOTAS-3.md", "notas-2.md", "notas.md"]);
  });

  it("avisa con tipos que Claude puede no leer bien (.docx) pero los guarda", async () => {
    const res = await upload([{ name: "spec.docx", data: "x" }, { name: "datos.csv", data: "a,b" }]);
    const [docx, csv] = res.json();
    expect(docx.warning).toMatch(/PDF o Markdown/);
    expect(csv.warning).toBeUndefined();
    expect(existsSync(path.join(docsDir(), "spec.docx"))).toBe(true);
  });

  it("un nombre con ../ no puede escapar de .task/", async () => {
    const res = await upload([{ name: "../../../evil.md", data: "x" }]);
    expect(res.statusCode).toBe(201);
    expect(res.json()[0].name).toBe("evil.md");
    expect(existsSync(path.join(docsDir(), "evil.md"))).toBe(true);
    expect(existsSync(path.join(task.worktreePath, "evil.md"))).toBe(false);
    expect(existsSync(path.join(fx.repo, "evil.md"))).toBe(false);
  });

  it("rechaza ficheros de más de 50 MB sin dejar nada a medias", async () => {
    const res = await upload([{ name: "enorme.pdf", data: new Uint8Array(MAX_DOC_BYTES + 1024) }]);
    expect(res.statusCode).toBe(413);
    expect(readdirSync(docsDir())).toEqual([]);
  }, 60_000);

  it("exige multipart y al menos un fichero", async () => {
    const bad = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/docs`, payload: { a: 1 }, headers: { host: `127.0.0.1:${PORT}` } });
    expect(bad.statusCode).toBe(415);
    expect(bad.json().error).toBe("not_multipart");
  });

  it("elimina un documento y 404 si no existe", async () => {
    await upload([{ name: "notas.md", data: "x" }]);
    expect((await call("DELETE", `/tasks/${task.id}/docs/notas.md`)).statusCode).toBe(204);
    expect(existsSync(path.join(docsDir(), "notas.md"))).toBe(false);
    const again = await call("DELETE", `/tasks/${task.id}/docs/notas.md`);
    expect(again.statusCode).toBe(404);
  });

  it("protege contra path traversal al borrar y al abrir", async () => {
    const outside = path.join(task.worktreePath, "fuera.txt");
    (await import("node:fs")).writeFileSync(outside, "no me borres");
    for (const evil of ["..%2Ffuera.txt", "..%5Cfuera.txt", "%2E%2E%2Ffuera.txt"]) {
      expect((await call("DELETE", `/tasks/${task.id}/docs/${evil}`)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await call("POST", `/tasks/${task.id}/docs/${evil}/open`)).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(existsSync(outside)).toBe(true);
    expect(opened).toEqual([]);
  });

  it("abre con la aplicación del sistema la ruta exacta del documento", async () => {
    await upload([{ name: "funcional.pdf", data: "x" }]);
    expect((await call("POST", `/tasks/${task.id}/docs/funcional.pdf/open`)).statusCode).toBe(204);
    expect(opened).toEqual([path.join(docsDir(), "funcional.pdf")]);
    expect((await call("POST", `/tasks/${task.id}/docs/nada.pdf/open`)).statusCode).toBe(404);
  });

  it("lista vacía si la tarea aún no tiene carpeta .task", async () => {
    await (await import("node:fs/promises")).rm(docsDir(), { recursive: true });
    expect((await call("GET", `/tasks/${task.id}/docs`)).json()).toEqual([]);
    expect((await upload([{ name: "a.md", data: "x" }])).statusCode).toBe(201); // la crea al subir
  });
});

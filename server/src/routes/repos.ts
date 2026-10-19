import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { GitService } from "../services/GitService.js";

const optionalText = z.string().trim().min(1).optional();
const repoPatch = z.object({
  name: optionalText,
  defaultBase: optionalText,
  branchTemplate: optionalText,
  setupCommand: optionalText,
  prUrlTemplate: optionalText,
});

export function registerRepoRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get("/repos", () => ctx.store.listRepos());

  api.post("/repos", async (req, reply) => {
    // "Copiar como ruta" de Windows entrecomilla la ruta.
    const unquoted = z.string().transform((s) => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim());
    const body = repoPatch.extend({ path: unquoted.pipe(z.string().min(1)) }).parse(req.body);
    const { path, ...extra } = body;
    return reply.code(201).send(await ctx.service.addRepo(path, extra));
  });

  api.patch("/repos/:id", async (req) => {
    const { id } = req.params as { id: string };
    return ctx.store.updateRepo(id, repoPatch.parse(req.body));
  });

  api.delete("/repos/:id", async (req, reply) => {
    await ctx.store.deleteRepo((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  api.post("/repos/:id/fetch", async (req) => {
    const repo = await ctx.store.getRepo((req.params as { id: string }).id);
    const error = await GitService.fetch(repo.path, true);
    if (error) throw new AppError(502, "fetch_failed", `git fetch falló: ${error}`);
    return { ok: true };
  });

  api.get("/repos/:id/branches", async (req) => {
    const repo = await ctx.store.getRepo((req.params as { id: string }).id);
    return GitService.branches(repo.path);
  });
}

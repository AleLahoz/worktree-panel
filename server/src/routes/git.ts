import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { GitService } from "../services/GitService.js";

export function registerGitRoutes(api: FastifyInstance, ctx: AppContext) {
  const task = async (req: { params: unknown }) => ctx.store.getTask((req.params as { id: string }).id);

  /** Ficheros con cambios (para la pestaña Git). */
  api.get("/tasks/:id/git/files", async (req) => GitService.changes((await task(req)).worktreePath));

  api.get("/tasks/:id/git/diff", async (req) => {
    const { file } = z.object({ file: z.string().min(1) }).parse(req.query);
    return GitService.diff((await task(req)).worktreePath, file);
  });

  api.post("/tasks/:id/git/push", async (req) => ({ output: await ctx.service.push(await task(req)) }));

  api.get("/tasks/:id/pr-url", async (req) => ctx.service.prUrl(await task(req)));
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

export function registerSessionRoutes(api: FastifyInstance, ctx: AppContext) {
  const task = async (req: { params: unknown }) => ctx.store.getTask((req.params as { id: string }).id);

  api.get("/tasks/:id/session", async (req) => {
    const t = await task(req);
    return ctx.sessions.states(t.id, t);
  });

  api.post("/tasks/:id/session/start", async (req) => {
    const saved = await ctx.sessions.startClaude(await task(req));
    return { sessionId: saved.sessionId, ...ctx.sessions.states(saved.id, saved) };
  });

  api.post("/tasks/:id/session/resume", async (req) => {
    const t = await task(req);
    await ctx.sessions.resumeClaude(t);
    return ctx.sessions.states(t.id, t);
  });

  api.post("/tasks/:id/session/stop", async (req) => {
    const t = await task(req);
    await ctx.sessions.stop(t.id, "claude");
    return ctx.sessions.states(t.id, t);
  });

  /** Escribe en la pty de Claude sin Enter (p. ej. "@.task/funcional.pdf "). */
  api.post("/tasks/:id/session/insert", async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(10_000) }).parse(req.body);
    ctx.sessions.insert((await task(req)).id, text);
    return reply.code(204).send();
  });

  /** Reescribe el prompt inicial (botón de respaldo si Claude no estuvo "listo" a tiempo). */
  api.post("/tasks/:id/session/initial-prompt", async (req, reply) => {
    await ctx.sessions.writeInitialPrompt(await task(req));
    return reply.code(204).send();
  });

  api.post("/tasks/:id/shell/start", async (req) => {
    const t = await task(req);
    await ctx.sessions.startShell(t);
    return ctx.sessions.states(t.id, t);
  });

  api.post("/tasks/:id/shell/stop", async (req) => {
    const t = await task(req);
    await ctx.sessions.stop(t.id, "shell");
    return ctx.sessions.states(t.id, t);
  });
}

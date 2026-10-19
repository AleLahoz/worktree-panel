import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import type { SavedDoc } from "../services/DocService.js";

export function registerDocRoutes(api: FastifyInstance, ctx: AppContext) {
  const task = async (req: { params: unknown }) => ctx.store.getTask((req.params as { id: string }).id);
  const name = (req: { params: unknown }) => (req.params as { name: string }).name;

  api.get("/tasks/:id/docs", async (req) => ctx.docs.list(await task(req)));

  /** multipart/form-data con uno o varios ficheros. Devuelve los guardados (con aviso si el tipo no es ideal). */
  api.post("/tasks/:id/docs", async (req, reply) => {
    const t = await task(req);
    if (!req.isMultipart()) throw new AppError(415, "not_multipart", "Se esperaba multipart/form-data");
    const saved: SavedDoc[] = [];
    for await (const part of req.files()) saved.push(await ctx.docs.save(t, part.filename, part.file));
    if (saved.length === 0) throw new AppError(400, "no_files", "No se ha recibido ningún fichero");
    return reply.code(201).send(saved);
  });

  api.delete("/tasks/:id/docs/:name", async (req, reply) => {
    await ctx.docs.remove(await task(req), name(req));
    return reply.code(204).send();
  });

  api.post("/tasks/:id/docs/:name/open", async (req, reply) => {
    await ctx.docs.open(await task(req), name(req));
    return reply.code(204).send();
  });
}

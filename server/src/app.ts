import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { AppError } from "./errors.js";
import multipart from "@fastify/multipart";
import { MAX_DOC_BYTES } from "./services/DocService.js";
import { registerDocRoutes } from "./routes/docs.js";
import { registerEnvRoutes } from "./routes/env.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerTaskRoutes } from "./routes/tasks.js";

/** Solo se aceptan peticiones cuyo Host y Origin sean locales (protege de DNS rebinding y webs externas). */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req, reply) => {
    if (!isAllowedHost(req.headers.host, ctx.port) || !isAllowedOrigin(req.headers.origin, ctx.port)) {
      return reply.code(403).send({ error: "forbidden_origin", message: "Origen no permitido" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_input", message: "Datos no válidos", details: err.issues });
    }
    // Errores 4xx de Fastify y sus plugins (p. ej. 413 de multipart): se devuelven tal cual.
    const fe = err as { statusCode?: number; code?: string };
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: fe.code ?? "bad_request", message: (err as Error).message });
    }
    console.error(err);
    return reply.code(500).send({ error: "internal", message: "Error interno" });
  });

  app.register(multipart, { limits: { fileSize: MAX_DOC_BYTES, files: 50 } });

  app.register(async (api) => {
    registerEnvRoutes(api, ctx);
    registerRepoRoutes(api, ctx);
    registerTaskRoutes(api, ctx);
    registerSessionRoutes(api, ctx);
    registerDocRoutes(api, ctx);
    registerGitRoutes(api, ctx);
  }, { prefix: "/api" });

  return app;
}

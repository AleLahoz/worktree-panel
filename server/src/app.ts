import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "./errors.js";
import { registerEnvRoutes } from "./routes/env.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import type { TaskService } from "./services/TaskService.js";
import type { TaskStore } from "./services/TaskStore.js";

export interface AppContext {
  port: number;
  dataDir: string;
  store: TaskStore;
  service: TaskService;
}

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
    console.error(err);
    return reply.code(500).send({ error: "internal", message: "Error interno" });
  });

  app.register(async (api) => {
    registerEnvRoutes(api, ctx);
    registerRepoRoutes(api, ctx);
    registerTaskRoutes(api, ctx);
  }, { prefix: "/api" });

  return app;
}

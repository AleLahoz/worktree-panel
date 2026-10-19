import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Sirve el frontend compilado (web/dist) con fallback a index.html para la SPA. No hace nada si no está compilado. */
export async function serveWeb(app: FastifyInstance, distDir: string): Promise<boolean> {
  if (!existsSync(path.join(distDir, "index.html"))) return false;
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/ws/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "not_found", message: "No encontrado" });
  });
  return true;
}

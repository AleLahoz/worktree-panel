import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { loadConfig, saveConfig } from "../config.js";

function tryRun(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

const configPatch = z
  .object({
    port: z.number().int().min(1024).max(65535),
    claudePath: z.string(),
    shellPath: z.string().min(1),
    initialPromptTemplate: z.string().min(1),
    defaultBranchTemplate: z.string().min(1),
    claudeAttribution: z.boolean(),
  })
  .partial();

export function registerEnvRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get("/config", () => loadConfig(ctx.dataDir));

  api.put("/config", async (req) => {
    const next = { ...(await loadConfig(ctx.dataDir)), ...configPatch.parse(req.body) };
    await saveConfig(next, ctx.dataDir);
    return next;
  });

  /** Versiones de git, node y claude, y recomendaciones del entorno. */
  api.get("/env/check", async () => {
    const config = await loadConfig(ctx.dataDir);
    const locator = process.platform === "win32" ? "where" : "which";
    const claudePath = config.claudePath || (await tryRun(locator, ["claude"]))?.split(/\r?\n/)[0] || null;
    const [git, claude, longpaths] = await Promise.all([
      tryRun("git", ["--version"]),
      claudePath ? tryRun(claudePath, ["--version"]) : Promise.resolve(null),
      tryRun("git", ["config", "--get", "core.longpaths"]),
    ]);
    const recommendations: string[] = [];
    if (process.platform === "win32" && longpaths !== "true") {
      recommendations.push("Activa las rutas largas: git config --global core.longpaths true");
    }
    return {
      git,
      node: process.version,
      claude: claudePath ? { path: claudePath, version: claude } : null,
      claudeAvailable: !!claude,
      recommendations,
    };
  });
}

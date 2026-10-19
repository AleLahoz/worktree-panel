import { buildApp } from "./app.js";
import { dataDir, loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { attachWebSocket } from "./ws.js";

const dir = dataDir();
const config = await loadConfig(dir);
const port = Number(process.env.PORT) || config.port;
const ctx = createContext(dir, port);
const app = buildApp(ctx);

await app.listen({ host: "127.0.0.1", port });
attachWebSocket(app.server, ctx.ptys, port);
console.log(`Worktree Panel escuchando en http://127.0.0.1:${port} (datos en ${dir})`);

// Al parar el backend mueren las terminales: las tareas quedan "Detenida" y se retoman con --resume.
const shutdown = async () => {
  await ctx.ptys.killAll();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

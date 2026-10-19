import { buildApp } from "./app.js";
import { dataDir, loadConfig } from "./config.js";
import { TaskService } from "./services/TaskService.js";
import { TaskStore } from "./services/TaskStore.js";

const dir = dataDir();
const config = await loadConfig(dir);
const port = Number(process.env.PORT) || config.port;
const store = new TaskStore(dir);
const service = new TaskService(store);
const app = buildApp({ port, dataDir: dir, store, service });

await app.listen({ host: "127.0.0.1", port });
console.log(`Worktree Panel escuchando en http://127.0.0.1:${port} (datos en ${dir})`);

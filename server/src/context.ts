import { loadConfig } from "./config.js";
import { PtyManager, type PtyOptions } from "./services/PtyManager.js";
import { SessionService, type SessionTimings } from "./services/SessionService.js";
import { TaskService } from "./services/TaskService.js";
import { TaskStore } from "./services/TaskStore.js";

export interface AppContext {
  port: number;
  dataDir: string;
  store: TaskStore;
  service: TaskService;
  ptys: PtyManager;
  sessions: SessionService;
}

export interface ContextOptions {
  pty?: PtyOptions;
  timings?: SessionTimings;
}

/** Cablea los servicios. Cerrar una tarea mata antes sus terminales (Windows no deja borrar un cwd en uso). */
export function createContext(dataDir: string, port: number, options: ContextOptions = {}): AppContext {
  const store = new TaskStore(dataDir);
  const service = new TaskService(store);
  const ptys = new PtyManager(options.pty);
  const sessions = new SessionService(ptys, store, () => loadConfig(dataDir), options.timings);
  service.onBeforeClose = (task) => sessions.killTask(task.id);
  return { port, dataDir, store, service, ptys, sessions };
}

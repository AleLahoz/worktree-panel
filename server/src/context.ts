import { loadConfig } from "./config.js";
import { DocService, type Opener } from "./services/DocService.js";
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
  docs: DocService;
}

export interface ContextOptions {
  pty?: PtyOptions;
  timings?: SessionTimings;
  /** Cómo abrir un documento con la app del sistema (se sustituye en tests). */
  opener?: Opener;
}

/** Cablea los servicios. Cerrar una tarea mata antes sus terminales (Windows no deja borrar un cwd en uso). */
export function createContext(dataDir: string, port: number, options: ContextOptions = {}): AppContext {
  const store = new TaskStore(dataDir);
  const service = new TaskService(store);
  const ptys = new PtyManager(options.pty);
  const sessions = new SessionService(ptys, store, () => loadConfig(dataDir), options.timings, dataDir);
  service.onBeforeClose = (task) => sessions.killTask(task.id);
  return { port, dataDir, store, service, ptys, sessions, docs: new DocService(options.opener) };
}

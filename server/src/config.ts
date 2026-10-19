import { homedir } from "node:os";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./services/atomicJson.js";

export interface AppConfig {
  port: number;
  claudePath: string;
  shellPath: string;
  initialPromptTemplate: string;
  defaultBranchTemplate: string;
}

export const DEFAULT_PROMPT_TEMPLATE = `Vas a trabajar la tarea {key}{title_suffix}.
Estás en la rama {branch}, que sale de {base}. Los PR irán contra {base}.
Documentación de la tarea: {doc_refs}
Antes de programar: lee la documentación, resume lo que entiendes y propón un plan. Espera mi confirmación.`;

export const DEFAULT_CONFIG: AppConfig = {
  port: 4317,
  claudePath: "",
  shellPath: "powershell.exe",
  initialPromptTemplate: DEFAULT_PROMPT_TEMPLATE,
  defaultBranchTemplate: "feature/{key}",
};

/** Carpeta de datos: %APPDATA%\worktree-panel en Windows, ~/.worktree-panel en el resto. */
export function dataDir(): string {
  if (process.env.WTP_DATA_DIR) return process.env.WTP_DATA_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "worktree-panel");
  return path.join(homedir(), ".worktree-panel");
}

export async function loadConfig(dir = dataDir()): Promise<AppConfig> {
  const stored = await readJson<Partial<AppConfig>>(path.join(dir, "config.json"), {});
  return { ...DEFAULT_CONFIG, ...stored };
}

export async function saveConfig(config: AppConfig, dir = dataDir()): Promise<void> {
  await writeJsonAtomic(path.join(dir, "config.json"), config);
}

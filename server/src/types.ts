export interface Repo {
  id: string;
  name: string;
  /** Raíz del checkout principal. */
  path: string;
  defaultBase?: string;
  branchTemplate?: string;
  setupCommand?: string;
  /** Con {web} {branch} {base}. */
  prUrlTemplate?: string;
}

export interface Task {
  id: string;
  repoId: string;
  /** Clave de Jira = nombre del worktree. */
  key: string;
  title?: string;
  jiraUrl?: string;
  branch: string;
  /** Ref para cálculos git (p. ej. origin/develop). */
  baseRef: string;
  /** Destino del PR (p. ej. develop). */
  prBase: string;
  worktreePath: string;
  sessionId?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitStatus {
  branch: string;
  baseRef: string;
  changedFiles: number;
  /** Commits sin subir (vs upstream, o vs base si no hay upstream). */
  unpushed: number;
  behindBase: number;
  hasUpstream: boolean;
  lastCommit?: { hash: string; subject: string; relative: string };
}

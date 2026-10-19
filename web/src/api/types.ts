export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBase?: string;
  branchTemplate?: string;
  setupCommand?: string;
  prUrlTemplate?: string;
}

export type SessionState = "none" | "running" | "waiting" | "stopped";
export interface SessionStates {
  claude: SessionState;
  shell: SessionState;
}

export interface GitStatus {
  branch: string;
  baseRef: string;
  changedFiles: number;
  unpushed: number;
  behindBase: number;
  hasUpstream: boolean;
  lastCommit?: { hash: string; subject: string; relative: string };
}

export interface Task {
  id: string;
  repoId: string;
  key: string;
  title?: string;
  jiraUrl?: string;
  branch: string;
  baseRef: string;
  prBase: string;
  worktreePath: string;
  sessionId?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskView extends Task {
  lost: boolean;
  status: GitStatus | null;
  session: SessionStates;
}

export interface Branches {
  local: string[];
  remote: string[];
}

export type BranchSpec =
  | { mode: "new"; branch: string; base: string }
  | { mode: "existing"; branch: string; base?: string };

export interface EnvCheck {
  git: string | null;
  node: string;
  claude: { path: string; version: string | null } | null;
  claudeAvailable: boolean;
  recommendations: string[];
}

export interface AppConfig {
  port: number;
  claudePath: string;
  shellPath: string;
  initialPromptTemplate: string;
  defaultBranchTemplate: string;
}

import type { AppConfig, Branches, BranchSpec, EnvCheck, Repo, SessionStates, Task, TaskView } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? `Error ${res.status}`, data.details);
  return data as T;
}

const get = <T>(url: string) => request<T>("GET", url);
const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {});

export const api = {
  config: () => get<AppConfig>("/config"),
  saveConfig: (patch: Partial<AppConfig>) => request<AppConfig>("PUT", "/config", patch),
  envCheck: () => get<EnvCheck>("/env/check"),

  repos: () => get<Repo[]>("/repos"),
  addRepo: (data: Partial<Repo> & { path: string }) => post<Repo>("/repos", data),
  updateRepo: (id: string, patch: Partial<Repo>) => request<Repo>("PATCH", `/repos/${id}`, patch),
  deleteRepo: (id: string) => request<void>("DELETE", `/repos/${id}`),
  fetchRepo: (id: string) => post<{ ok: true }>(`/repos/${id}/fetch`),
  branches: (id: string) => get<Branches>(`/repos/${id}/branches`),

  tasks: () => get<TaskView[]>("/tasks"),
  createTask: (data: { repoId: string; key: string; title?: string; jiraUrl?: string; branch: BranchSpec; startSession: boolean }) =>
    post<{ task: Task; warnings: string[]; session: SessionStates }>("/tasks", data),
  closeTask: (id: string, opts: { force?: boolean; deleteBranch?: boolean }) =>
    post<{ summary: { dirty: number; unpushed: number }; branchDeleted: boolean }>(`/tasks/${id}/close`, opts),
  archiveTask: (id: string) => post<void>(`/tasks/${id}/archive`),

  startSession: (id: string) => post<SessionStates>(`/tasks/${id}/session/start`),
  resumeSession: (id: string) => post<SessionStates>(`/tasks/${id}/session/resume`),
  stopSession: (id: string) => post<SessionStates>(`/tasks/${id}/session/stop`),
  insert: (id: string, text: string) => post<void>(`/tasks/${id}/session/insert`, { text }),
  initialPrompt: (id: string) => post<void>(`/tasks/${id}/session/initial-prompt`),
  startShell: (id: string) => post<SessionStates>(`/tasks/${id}/shell/start`),
  stopShell: (id: string) => post<SessionStates>(`/tasks/${id}/shell/stop`),
};

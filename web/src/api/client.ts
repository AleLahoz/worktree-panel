import type { AppConfig, Branches, BranchSpec, DocInfo, EnvCheck, FileChange, FileDiff, OrphanWorktree, Repo, SavedDoc, SessionStates, Task, TaskView } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined && !isForm ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
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
  reconcile: () => get<{ lost: Task[]; orphans: OrphanWorktree[] }>("/reconcile"),
  importTask: (data: { repoId: string; key: string; baseRef?: string }) => post<Task>("/tasks/import", data),

  patchTask: (id: string, patch: { title?: string; jiraUrl?: string; prUrl?: string }) => request<Task>("PATCH", `/tasks/${id}`, patch),
  gitFiles: (id: string) => get<FileChange[]>(`/tasks/${id}/git/files`),
  gitDiff: (id: string, file: string) => get<FileDiff>(`/tasks/${id}/git/diff?file=${encodeURIComponent(file)}`),
  push: (id: string) => post<{ output: string }>(`/tasks/${id}/git/push`),
  prUrl: (id: string) => get<{ url: string; provider: string }>(`/tasks/${id}/pr-url`),

  docs: (id: string) => get<DocInfo[]>(`/tasks/${id}/docs`),
  uploadDocs: (id: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    return request<SavedDoc[]>("POST", `/tasks/${id}/docs`, form);
  },
  deleteDoc: (id: string, name: string) => request<void>("DELETE", `/tasks/${id}/docs/${encodeURIComponent(name)}`),
  openDoc: (id: string, name: string) => post<void>(`/tasks/${id}/docs/${encodeURIComponent(name)}/open`),

  startSession: (id: string) => post<SessionStates>(`/tasks/${id}/session/start`),
  resumeSession: (id: string) => post<SessionStates>(`/tasks/${id}/session/resume`),
  stopSession: (id: string) => post<SessionStates>(`/tasks/${id}/session/stop`),
  insert: (id: string, text: string) => post<void>(`/tasks/${id}/session/insert`, { text }),
  initialPrompt: (id: string) => post<void>(`/tasks/${id}/session/initial-prompt`),
  startShell: (id: string) => post<SessionStates>(`/tasks/${id}/shell/start`),
  stopShell: (id: string) => post<SessionStates>(`/tasks/${id}/shell/stop`),
};

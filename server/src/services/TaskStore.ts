import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { Repo, Task } from "../types.js";
import { readJson, writeJsonAtomic } from "./atomicJson.js";

/** Persistencia en ficheros JSON: repos.json, tasks/<id>.json y archive/<id>.json. */
export class TaskStore {
  constructor(private dir: string) {}

  private reposFile = () => path.join(this.dir, "repos.json");
  private taskFile = (id: string) => path.join(this.dir, "tasks", `${id}.json`);

  // --- repos ---
  async listRepos(): Promise<Repo[]> {
    return readJson<Repo[]>(this.reposFile(), []);
  }

  async getRepo(id: string): Promise<Repo> {
    const repo = (await this.listRepos()).find((r) => r.id === id);
    if (!repo) throw new AppError(404, "repo_not_found", `Repo ${id} no encontrado`);
    return repo;
  }

  async addRepo(data: Omit<Repo, "id">): Promise<Repo> {
    const repos = await this.listRepos();
    if (repos.some((r) => path.resolve(r.path).toLowerCase() === path.resolve(data.path).toLowerCase())) {
      throw new AppError(409, "repo_exists", "Ese repo ya está registrado");
    }
    const repo: Repo = { id: randomUUID(), ...data };
    await writeJsonAtomic(this.reposFile(), [...repos, repo]);
    return repo;
  }

  async updateRepo(id: string, patch: Partial<Omit<Repo, "id" | "path">>): Promise<Repo> {
    const repos = await this.listRepos();
    const i = repos.findIndex((r) => r.id === id);
    if (i < 0) throw new AppError(404, "repo_not_found", `Repo ${id} no encontrado`);
    repos[i] = { ...repos[i], ...patch };
    await writeJsonAtomic(this.reposFile(), repos);
    return repos[i];
  }

  async deleteRepo(id: string): Promise<void> {
    const repos = await this.listRepos();
    if (!repos.some((r) => r.id === id)) throw new AppError(404, "repo_not_found", `Repo ${id} no encontrado`);
    if ((await this.listTasks()).some((t) => t.repoId === id)) {
      throw new AppError(409, "repo_has_tasks", "El repo tiene tareas activas; ciérralas antes de quitarlo");
    }
    await writeJsonAtomic(this.reposFile(), repos.filter((r) => r.id !== id));
  }

  // --- tareas ---
  async listTasks(): Promise<Task[]> {
    let files: string[];
    try {
      files = await readdir(path.join(this.dir, "tasks"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const tasks = await Promise.all(
      files.filter((f) => f.endsWith(".json")).map((f) => readJson<Task | null>(path.join(this.dir, "tasks", f), null)),
    );
    return tasks.filter((t): t is Task => t !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getTask(id: string): Promise<Task> {
    const task = await readJson<Task | null>(this.taskFile(id), null);
    if (!task) throw new AppError(404, "task_not_found", `Tarea ${id} no encontrada`);
    return task;
  }

  async saveTask(task: Task): Promise<Task> {
    const saved = { ...task, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.taskFile(task.id), saved);
    return saved;
  }

  async createTask(data: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task> {
    const now = new Date().toISOString();
    return this.saveTask({ ...data, id: randomUUID(), createdAt: now, updatedAt: now });
  }

  /** Mueve el JSON a archive/ (no se borra). */
  async archiveTask(id: string): Promise<void> {
    await this.getTask(id);
    await mkdir(path.join(this.dir, "archive"), { recursive: true });
    await rename(this.taskFile(id), path.join(this.dir, "archive", `${id}.json`));
  }
}

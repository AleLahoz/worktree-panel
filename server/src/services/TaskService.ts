import { mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import type { GitStatus, Repo, Task } from "../types.js";
import { GitService, type BranchMode } from "./GitService.js";
import type { TaskStore } from "./TaskStore.js";

export interface CreateTaskInput {
  repoId: string;
  key: string;
  title?: string;
  jiraUrl?: string;
  branch: BranchMode;
  /** Rutas locales de ficheros a copiar a .task/ (las sube la API de documentos en la Fase 3). */
  docs?: { name: string; path: string }[];
}

export interface CloseInput {
  force?: boolean;
  deleteBranch?: boolean;
}

export interface CloseSummary {
  dirty: number;
  unpushed: number;
}

export interface OrphanWorktree {
  repoId: string;
  key: string;
  path: string;
  branch?: string;
}

export class TaskService {
  /** Gancho para detener sesiones vivas antes de cerrar (lo conecta la Fase 2). */
  onBeforeClose: (task: Task) => Promise<void> = async () => {};

  constructor(private store: TaskStore) {}

  async addRepo(inputPath: string, extra: Partial<Omit<Repo, "id" | "path">> = {}): Promise<Repo> {
    const root = await GitService.repoRoot(inputPath);
    await GitService.ensureExcluded(root);
    return this.store.addRepo({ name: path.basename(root), ...extra, path: root });
  }

  async createTask(input: CreateTaskInput): Promise<{ task: Task; warnings: string[] }> {
    const repo = await this.store.getRepo(input.repoId);
    const warnings: string[] = [];
    if ((await this.store.listTasks()).some((t) => t.repoId === repo.id && t.key.toLowerCase() === input.key.toLowerCase())) {
      throw new AppError(409, "task_exists", `Ya existe una tarea ${input.key} en este repo`);
    }

    const fetchError = await GitService.fetch(repo.path);
    if (fetchError) warnings.push(`No se pudo hacer fetch (se usa lo cacheado): ${fetchError}`);

    await GitService.ensureExcluded(repo.path); // por si el repo se registró antes de esta versión
    const wt = await GitService.addWorktree(repo.path, input.key, input.branch, repo.defaultBase);

    try {
      const taskDir = path.join(wt.worktreePath, ".task");
      await mkdir(taskDir, { recursive: true });
      for (const doc of input.docs ?? []) await cp(doc.path, path.join(taskDir, path.basename(doc.name)));
      await GitService.copyWorktreeInclude(repo.path, wt.worktreePath);
      const task = await this.store.createTask({
        repoId: repo.id,
        key: input.key,
        title: input.title,
        jiraUrl: input.jiraUrl,
        branch: wt.branch,
        baseRef: wt.baseRef,
        prBase: wt.prBase,
        worktreePath: wt.worktreePath,
      });
      return { task, warnings };
    } catch (e) {
      // Deshacer el worktree recién creado para no dejar basura si algo falla después.
      await GitService.removeWorktree(repo.path, wt.worktreePath, true).catch(() => {});
      throw e;
    }
  }

  async status(task: Task): Promise<GitStatus> {
    return GitService.status(task.worktreePath, task.baseRef);
  }

  /** ¿Existe aún el worktree de la tarea según git? */
  async worktreeExists(task: Task): Promise<boolean> {
    const repo = await this.store.getRepo(task.repoId);
    const target = GitService.norm(task.worktreePath);
    return (await GitService.listWorktrees(repo.path)).some((w) => !w.missing && GitService.norm(w.path) === target);
  }

  async closeTask(id: string, opts: CloseInput = {}): Promise<{ summary: CloseSummary; branchDeleted: boolean }> {
    const task = await this.store.getTask(id);
    const repo = await this.store.getRepo(task.repoId);
    const exists = await this.worktreeExists(task);

    let summary: CloseSummary = { dirty: 0, unpushed: 0 };
    if (exists) {
      const st = await this.status(task);
      summary = { dirty: st.changedFiles, unpushed: st.unpushed };
      if ((summary.dirty > 0 || summary.unpushed > 0) && !opts.force) {
        throw new AppError(409, "unsaved_work", "La tarea tiene trabajo sin subir", summary);
      }
    }

    await this.onBeforeClose(task);
    if (exists) await GitService.removeWorktree(repo.path, task.worktreePath, summary.dirty > 0);
    else {
      // Worktree perdido: se limpia el registro y cualquier directorio sobrante de un borrado a medias.
      await GitService.prune(repo.path);
      await GitService.removeLeftoverDir(repo.path, task.worktreePath);
    }

    let branchDeleted = false;
    if (opts.deleteBranch) {
      await GitService.deleteBranch(repo.path, task.branch, !!opts.force);
      branchDeleted = true;
    }
    await this.store.archiveTask(id);
    return { summary, branchDeleted };
  }

  /**
   * Compara las tareas con `git worktree list` de cada repo:
   * `lost` = tareas cuyo worktree ya no existe; `orphans` = worktrees bajo .claude/worktrees sin tarea.
   */
  async reconcile(): Promise<{ lost: Task[]; orphans: OrphanWorktree[] }> {
    const repos = await this.store.listRepos();
    const tasks = await this.store.listTasks();
    const lost: Task[] = [];
    const orphans: OrphanWorktree[] = [];
    for (const repo of repos) {
      let worktrees;
      try {
        worktrees = await GitService.listWorktrees(repo.path);
      } catch {
        continue; // repo movido o borrado: no marcar todo como perdido
      }
      const known = new Set(worktrees.filter((w) => !w.missing).map((w) => GitService.norm(w.path)));
      const repoTasks = tasks.filter((t) => t.repoId === repo.id);
      lost.push(...repoTasks.filter((t) => !known.has(GitService.norm(t.worktreePath))));
      const root = GitService.norm(path.join(repo.path, ".claude", "worktrees")) + path.sep;
      const taskPaths = new Set(repoTasks.map((t) => GitService.norm(t.worktreePath)));
      for (const w of worktrees) {
        const n = GitService.norm(w.path);
        if (n.startsWith(root) && !taskPaths.has(n)) {
          orphans.push({ repoId: repo.id, key: path.basename(w.path), path: w.path, branch: w.branch });
        }
      }
    }
    return { lost, orphans };
  }

  /** Convierte un worktree huérfano en tarea. */
  async importWorktree(repoId: string, key: string, baseRef?: string): Promise<Task> {
    const repo = await this.store.getRepo(repoId);
    const base = baseRef ?? repo.defaultBase;
    if (!base) throw new AppError(400, "base_required", "Indica la rama base");
    const wtPath = path.join(repo.path, ".claude", "worktrees", key);
    const wt = (await GitService.listWorktrees(repo.path)).find((w) => GitService.norm(w.path) === GitService.norm(wtPath));
    if (!wt?.branch) throw new AppError(404, "worktree_not_found", `No hay un worktree con rama en ${wtPath}`);
    return this.store.createTask({
      repoId,
      key,
      branch: wt.branch,
      baseRef: base,
      prBase: await GitService.stripRemote(repo.path, base),
      worktreePath: wtPath,
    });
  }
}

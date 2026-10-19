import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { KEY_RE } from "../services/GitService.js";

const text = z.string().trim().min(1);

const createTask = z.object({
  repoId: text,
  key: z.string().regex(KEY_RE, "Clave no válida: solo [A-Za-z0-9._-], máx. 64"),
  title: text.optional(),
  jiraUrl: z.string().trim().url().optional(),
  branch: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("new"), branch: text, base: text }),
    z.object({ mode: z.literal("existing"), branch: text, base: text.optional() }),
  ]),
  /** Iniciar la sesión de Claude tras crear (por defecto sí). */
  startSession: z.boolean().default(true),
});

const patchTask = z.object({
  title: z.string().trim().optional(),
  jiraUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
  prUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
});

const closeTask = z.object({ force: z.boolean().optional(), deleteBranch: z.boolean().optional() });

export function registerTaskRoutes(api: FastifyInstance, ctx: AppContext) {
  /** Tareas con su estado git resumido; `lost` si el worktree ya no existe. */
  api.get("/tasks", async () => {
    const tasks = await ctx.store.listTasks();
    return Promise.all(
      tasks.map(async (task) => {
        const lost = !(await ctx.service.worktreeExists(task).catch(() => false));
        const status = lost ? null : await ctx.service.status(task).catch(() => null);
        return { ...task, lost, status, session: ctx.sessions.states(task.id, task) };
      }),
    );
  });

  api.post("/tasks", async (req, reply) => {
    const { startSession, ...input } = createTask.parse(req.body);
    const created = await ctx.service.createTask(input);
    let task = created.task;
    const warnings = [...created.warnings];
    // Tras crear: shell con el setupCommand del repo y, si se pidió, la sesión de Claude.
    // Un fallo aquí no invalida la tarea (el worktree ya existe): se avisa.
    const repo = await ctx.store.getRepo(task.repoId);
    if (repo.setupCommand) {
      await ctx.sessions.startShell(task, repo.setupCommand).catch((e: Error) => warnings.push(`No se pudo ejecutar setupCommand: ${e.message}`));
    }
    if (startSession) {
      task = await ctx.sessions.startClaude(task).catch((e: Error) => {
        warnings.push(`No se pudo iniciar Claude: ${e.message}`);
        return task;
      });
    }
    return reply.code(201).send({ task, warnings, session: ctx.sessions.states(task.id, task) });
  });

  api.get("/tasks/:id", async (req) => ctx.store.getTask((req.params as { id: string }).id));

  api.patch("/tasks/:id", async (req) => {
    const task = await ctx.store.getTask((req.params as { id: string }).id);
    const patch = patchTask.parse(req.body);
    const clean = (v?: string) => (v === "" ? undefined : v);
    return ctx.store.saveTask({
      ...task,
      ...(patch.title !== undefined && { title: clean(patch.title) }),
      ...(patch.jiraUrl !== undefined && { jiraUrl: clean(patch.jiraUrl) }),
      ...(patch.prUrl !== undefined && { prUrl: clean(patch.prUrl) }),
    });
  });

  api.post("/tasks/:id/close", async (req) => {
    const { id } = req.params as { id: string };
    return ctx.service.closeTask(id, closeTask.parse(req.body ?? {}));
  });

  api.get("/tasks/:id/git/status", async (req) => {
    const task = await ctx.store.getTask((req.params as { id: string }).id);
    return ctx.service.status(task);
  });

  /** Reconciliación (RF9): tareas con worktree perdido y worktrees sin tarea. */
  api.get("/reconcile", () => ctx.service.reconcile());

  api.post("/tasks/import", async (req, reply) => {
    const body = z.object({ repoId: text, key: z.string().regex(KEY_RE), baseRef: text.optional() }).parse(req.body);
    return reply.code(201).send(await ctx.service.importWorktree(body.repoId, body.key, body.baseRef));
  });

  /** Archivar una tarea con worktree perdido (sin tocar git más que un prune). */
  api.post("/tasks/:id/archive", async (req, reply) => {
    const task = await ctx.store.getTask((req.params as { id: string }).id);
    if (await ctx.service.worktreeExists(task)) {
      throw new AppError(409, "worktree_exists", "El worktree existe; usa el cierre normal de la tarea");
    }
    await ctx.service.closeTask(task.id);
    return reply.code(204).send();
  });
}

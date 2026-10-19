import type { TaskView } from "../api/types";

export const SESSION_LABEL = { none: "Sin sesión", running: "En ejecución", waiting: "Esperando", stopped: "Detenida" } as const;

export type VisualState = keyof typeof SESSION_LABEL | "lost";

export const visualState = (t: TaskView): VisualState => (t.lost ? "lost" : t.session.claude);
export const stateLabel = (t: TaskView) => (t.lost ? "Worktree perdido" : SESSION_LABEL[t.session.claude]);

/** Tono estable por repositorio, para distinguir las tarjetas de un vistazo. */
export function repoHue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

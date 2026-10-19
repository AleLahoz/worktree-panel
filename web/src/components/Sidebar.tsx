import { useMemo } from "react";
import type { OrphanWorktree, Repo, TaskView } from "../api/types";

interface Props {
  repos: Repo[];
  tasks: TaskView[];
  selectedId?: string;
  filter: string;
  onFilter: (v: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
  orphans: OrphanWorktree[];
  onImport: (o: OrphanWorktree) => void;
}

export const SESSION_LABEL = { none: "Sin sesión", running: "En ejecución", waiting: "Esperando", stopped: "Detenida" } as const;

export function Sidebar({ repos, tasks, selectedId, filter, onFilter, onSelect, onNew, onSettings, filterRef, orphans, onImport }: Props) {
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (t: TaskView) => !q || [t.key, t.title, t.branch].some((s) => s?.toLowerCase().includes(q));
    return repos.map((repo) => ({ repo, tasks: tasks.filter((t) => t.repoId === repo.id && match(t)) })).filter((g) => g.tasks.length || !q);
  }, [repos, tasks, filter]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="btn primary" onClick={onNew} title="Ctrl+N">Nueva tarea</button>
        <input ref={filterRef} className="filter" placeholder="Filtrar tareas (Ctrl+K)" value={filter} onChange={(e) => onFilter(e.target.value)} />
      </div>

      <nav className="repo-list" aria-label="Tareas por repositorio">
        {repos.length === 0 && <p className="hint">Aún no hay repositorios. Añade uno en Ajustes para empezar.</p>}
        {groups.map(({ repo, tasks }) => (
          <section key={repo.id} className="repo">
            <h3 className="repo-name" title={repo.path}>{repo.name}</h3>
            {tasks.length === 0 && <p className="hint small">Sin tareas</p>}
            <ul className="trunk">
              {tasks.map((t) => {
                const state = t.lost ? "lost" : t.session.claude;
                return (
                  <li key={t.id}>
                    <button className={`task-row${t.id === selectedId ? " selected" : ""}`} onClick={() => onSelect(t.id)}>
                      <span className={`node ${state}`} role="img" aria-label={t.lost ? "Worktree perdido" : SESSION_LABEL[t.session.claude]} />
                      <span className="task-main">
                        <span className="task-line">
                          <span className="mono key">{t.key}</span>
                          {t.title && <span className="title">{t.title}</span>}
                        </span>
                        <span className="task-sub">
                          <span className="mono branch">{t.branch}</span>
                          {t.lost && <span className="badge danger">Worktree perdido</span>}
                          {!!t.status?.changedFiles && <span className="badge" title="Ficheros con cambios sin commitear">{t.status.changedFiles} cambios</span>}
                          {!!t.status?.unpushed && <span className="badge accent" title="Commits sin subir">{t.status.unpushed} sin subir</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {orphans.length > 0 && (
          <section className="repo orphans">
            <h3 className="repo-name">Worktrees sin tarea</h3>
            <ul className="plain">
              {orphans.map((o) => (
                <li key={o.path} className="orphan">
                  <span className="mono" title={o.path}>{o.key}{o.branch ? ` · ${o.branch}` : ""}</span>
                  <button className="link-btn" onClick={() => onImport(o)}>Importar como tarea</button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </nav>

      <div className="sidebar-bottom">
        <button className="btn ghost" onClick={onSettings}>Ajustes</button>
      </div>
    </aside>
  );
}

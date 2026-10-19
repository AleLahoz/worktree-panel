import { LayoutDashboard, Plus, Search, Settings, Waypoints } from "lucide-react";
import type { TaskView } from "../api/types";
import { stateLabel, visualState } from "./session";

interface Props {
  tasks: TaskView[];
  selectedId?: string;
  filter: string;
  onFilter: (v: string) => void;
  onSelect: (id: string) => void;
  onBoard: () => void;
  onNew: () => void;
  onSettings: () => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
}

export function TopBar({ tasks, selectedId, filter, onFilter, onSelect, onBoard, onNew, onSettings, filterRef }: Props) {
  return (
    <header className="topbar">
      <button className="brand" onClick={onBoard} title="Volver al tablero">
        <Waypoints size={18} />
        <span>Worktree Panel</span>
      </button>

      <button className={`btn sm${selectedId ? "" : " active"}`} onClick={onBoard}><LayoutDashboard size={14} />Tablero</button>

      <nav className="switcher" aria-label="Tareas abiertas">
        {tasks.map((t) => (
          <button
            key={t.id}
            className={`chip-task${t.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(t.id)}
            title={`${t.key}${t.title ? ` — ${t.title}` : ""} · ${stateLabel(t)}`}
          >
            <i className={`dot ${visualState(t)}`} />
            <span className="mono">{t.key}</span>
          </button>
        ))}
      </nav>

      <span className="spacer" />

      <label className="search">
        <Search size={14} />
        <input ref={filterRef} placeholder="Filtrar tareas" value={filter} onChange={(e) => onFilter(e.target.value)} />
        <kbd>Ctrl K</kbd>
      </label>
      <button className="btn primary sm" onClick={onNew} title="Ctrl+N"><Plus size={15} />Nueva tarea</button>
      <button className="icon-btn" onClick={onSettings} aria-label="Ajustes" title="Ajustes"><Settings size={17} /></button>
    </header>
  );
}

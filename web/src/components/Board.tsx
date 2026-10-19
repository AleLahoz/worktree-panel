import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, GitBranch, LayoutGrid, ArrowUpFromLine, FileDiff, PackagePlus, Sparkles } from "lucide-react";
import type { OrphanWorktree, Repo, TaskView } from "../api/types";
import { repoHue, stateLabel, visualState } from "./session";

interface Pos { x: number; y: number }
type Layout = Record<string, Pos>;

const STORAGE = "wtp-board-v1";
const CARD_W = 272;
const CARD_H = 156;
const GAP = 28;

function loadLayout(): { cards: Layout; pan: Pos } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
    if (raw?.cards) return { cards: raw.cards, pan: raw.pan ?? { x: 0, y: 0 } };
  } catch { /* almacenamiento no disponible */ }
  return { cards: {}, pan: { x: 0, y: 0 } };
}

/** Una columna por repositorio, las tareas apiladas debajo de su nombre. */
function autoPosition(repos: Repo[], items: { id: string; repoId: string }[]): Layout {
  const out: Layout = {};
  const perRepo = new Map<string, number>();
  const colOf = new Map(repos.map((r, i) => [r.id, i]));
  for (const it of items) {
    const n = perRepo.get(it.repoId) ?? 0;
    perRepo.set(it.repoId, n + 1);
    out[it.id] = { x: 56 + (colOf.get(it.repoId) ?? 0) * (CARD_W + GAP), y: 72 + n * (CARD_H + GAP) };
  }
  return out;
}

interface Props {
  repos: Repo[];
  tasks: TaskView[];
  orphans: OrphanWorktree[];
  filter: string;
  selectedId?: string;
  onOpen: (id: string) => void;
  onImport: (o: OrphanWorktree) => void;
  onNew: () => void;
}

export function Board({ repos, tasks, orphans, filter, selectedId, onOpen, onImport, onNew }: Props) {
  const [{ cards, pan }, setState] = useState(loadLayout);
  const [dragId, setDragId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const z = useRef(1);
  const zOf = useRef(new Map<string, number>());
  const stage = useRef<HTMLDivElement>(null);

  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () => tasks.filter((t) => !q || [t.key, t.title, t.branch].some((s) => s?.toLowerCase().includes(q))),
    [tasks, q],
  );

  // Las tareas nuevas (sin posición guardada) se colocan en su columna sin mover las que el usuario ya ordenó.
  const items = useMemo(() => [...tasks.map((t) => ({ id: t.id, repoId: t.repoId })), ...orphans.map((o) => ({ id: `orphan:${o.path}`, repoId: o.repoId }))], [tasks, orphans]);
  const positions = useMemo(() => {
    const auto = autoPosition(repos, items);
    const taken = new Set(Object.values(cards).map((p) => `${Math.round(p.x)}:${Math.round(p.y)}`));
    const out: Layout = {};
    for (const it of items) {
      let p = cards[it.id] ?? auto[it.id];
      if (!cards[it.id]) while (taken.has(`${Math.round(p.x)}:${Math.round(p.y)}`)) p = { x: p.x, y: p.y + CARD_H + GAP };
      if (!cards[it.id]) taken.add(`${Math.round(p.x)}:${Math.round(p.y)}`);
      out[it.id] = p;
    }
    return out;
  }, [cards, items, repos]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE, JSON.stringify({ cards, pan })); } catch { /* sin almacenamiento */ }
  }, [cards, pan]);

  const move = useCallback((id: string, p: Pos) => setState((s) => ({ ...s, cards: { ...s.cards, [id]: p } })), []);

  const startDrag = (e: React.PointerEvent, id: string, onClick: () => void) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const origin = positions[id];
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) { moved = true; setDragId(id); zOf.current.set(id, ++z.current); }
      move(id, { x: origin.x + dx, y: origin.y + dy });
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      setDragId(null);
      if (!moved) onClick();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const startPan = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, origin = pan;
    setPanning(true);
    const onMove = (ev: PointerEvent) => setState((s) => ({ ...s, pan: { x: origin.x + ev.clientX - sx, y: origin.y + ev.clientY - sy } }));
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      setPanning(false);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const onWheel = (e: React.WheelEvent) => setState((s) => ({ ...s, pan: { x: s.pan.x - e.deltaX, y: s.pan.y - e.deltaY } }));

  const tidy = () => setState((s) => ({ ...s, cards: {}, pan: { x: 0, y: 0 } }));

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? "";
  const waiting = tasks.filter((t) => t.session.claude === "waiting").length;

  return (
    <div
      ref={stage}
      className={`board${panning ? " panning" : ""}`}
      onPointerDown={startPan}
      onWheel={onWheel}
      style={{ backgroundPosition: `${pan.x}px ${pan.y}px` }}
    >
      <div className="board-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        {repos.map((r, i) => (
          <div key={r.id} className="lane-label" style={{ left: 56 + i * (CARD_W + GAP), top: 36, ["--hue" as string]: repoHue(r.id) }}>
            <FolderGit2 size={14} /> {r.name}
          </div>
        ))}

        {visible.map((t, i) => {
          const p = positions[t.id];
          const st = visualState(t);
          return (
            <div
              key={t.id}
              className={`card-pos${dragId === t.id ? " dragging" : ""}`}
              style={{ transform: `translate(${p.x}px, ${p.y}px)`, zIndex: zOf.current.get(t.id) ?? 1, width: CARD_W }}
            >
              <div
                role="button"
                tabIndex={0}
                aria-label={`${t.key} ${t.title ?? ""} — ${stateLabel(t)}`}
                className={`task-card ${st}${t.id === selectedId ? " selected" : ""}`}
                style={{ ["--hue" as string]: repoHue(t.repoId), animationDelay: `${(i % 7) * -0.9}s` }}
                onPointerDown={(e) => { e.stopPropagation(); startDrag(e, t.id, () => onOpen(t.id)); }}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen(t.id))}
              >
                <div className="card-top">
                  <span className="mono card-key">{t.key}</span>
                  <span className={`state-pill ${st}`}><i className="dot" />{stateLabel(t)}</span>
                </div>
                <div className="card-title">{t.title || <span className="muted">Sin título</span>}</div>
                <div className="card-branch mono"><GitBranch size={12} />{t.branch}</div>
                <div className="card-foot">
                  <span className="card-repo">{repoName(t.repoId)}</span>
                  {!!t.status?.changedFiles && <span className="badge" title="Ficheros con cambios sin commitear"><FileDiff size={11} />{t.status.changedFiles}</span>}
                  {!!t.status?.unpushed && <span className="badge accent" title="Commits sin subir"><ArrowUpFromLine size={11} />{t.status.unpushed}</span>}
                </div>
              </div>
            </div>
          );
        })}

        {!q && orphans.map((o) => {
          const p = positions[`orphan:${o.path}`];
          return (
            <div key={o.path} className="card-pos" style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: CARD_W }}>
              <div className="task-card ghost" onPointerDown={(e) => e.stopPropagation()}>
                <div className="card-top"><span className="mono card-key">{o.key}</span><span className="state-pill none"><i className="dot" />Sin tarea</span></div>
                <div className="card-branch mono" title={o.path}><GitBranch size={12} />{o.branch ?? o.path}</div>
                <button className="btn sm" onClick={() => onImport(o)}><PackagePlus size={14} />Importar como tarea</button>
              </div>
            </div>
          );
        })}
      </div>

      {tasks.length === 0 && (
        <div className="board-empty">
          <Sparkles size={22} />
          <h2>Tu tablero está vacío</h2>
          <p>Cada tarea aparecerá aquí como una tarjeta flotante que puedes mover. Haz clic en una para abrir su chat, documentos, shell y git.</p>
          <button className="btn primary" onClick={onNew}>Nueva tarea</button>
        </div>
      )}

      <div className="board-hud">
        <span className="hud-chip"><i className="dot running" />{tasks.filter((t) => t.session.claude === "running").length} en ejecución</span>
        <span className={`hud-chip${waiting ? " attn" : ""}`}><i className="dot waiting" />{waiting} esperando</span>
        <button className="btn sm ghost" onClick={tidy} title="Reordena las tarjetas por repositorio"><LayoutGrid size={14} />Ordenar</button>
      </div>
    </div>
  );
}

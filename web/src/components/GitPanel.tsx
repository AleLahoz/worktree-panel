import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { FileChange, FileDiff, TaskView } from "../api/types";

const KIND_LABEL: Record<FileChange["kind"], { letter: string; text: string }> = {
  modified: { letter: "M", text: "Modificado" },
  added: { letter: "A", text: "Añadido" },
  deleted: { letter: "D", text: "Eliminado" },
  renamed: { letter: "R", text: "Renombrado" },
  untracked: { letter: "N", text: "Nuevo, sin seguimiento" },
  conflict: { letter: "!", text: "En conflicto" },
};

interface Props {
  task: TaskView;
  /** Solo se refresca mientras la pestaña está a la vista. */
  active: boolean;
  onSavePrUrl: (url: string) => Promise<void>;
}

export function GitPanel({ task, active, onSavePrUrl }: Props) {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [selected, setSelected] = useState<string>();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState("");
  const [prUrl, setPrUrl] = useState(task.prUrl ?? "");
  const [saved, setSaved] = useState(false);

  const loadFiles = useCallback(async () => {
    try {
      const list = await api.gitFiles(task.id);
      setFiles(list);
      setError("");
      setSelected((cur) => (cur && list.some((f) => f.path === cur) ? cur : list[0]?.path));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [task.id]);

  useEffect(() => {
    if (!active) return;
    loadFiles();
    const id = window.setInterval(loadFiles, 10_000);
    return () => window.clearInterval(id);
  }, [active, loadFiles]);

  useEffect(() => {
    setDiff(null);
    if (!selected) return;
    let stale = false;
    api.gitDiff(task.id, selected).then((d) => !stale && setDiff(d)).catch(() => !stale && setDiff(null));
    return () => {
      stale = true;
    };
  }, [task.id, selected, files]);

  useEffect(() => setPrUrl(task.prUrl ?? ""), [task.prUrl]);

  return (
    <div className="git-panel">
      <div className="git-body">
        <aside className="git-files" aria-label="Ficheros con cambios">
          <div className="git-files-head">
            <span>{files.length} {files.length === 1 ? "fichero" : "ficheros"}</span>
            <button className="link-btn" onClick={loadFiles}>Actualizar</button>
          </div>
          {error && <p className="error small">{error}</p>}
          {files.length === 0 && !error && <p className="hint">No hay cambios sin commitear.</p>}
          <ul>
            {files.map((f) => (
              <li key={f.path}>
                <button className={`git-file${f.path === selected ? " selected" : ""}`} onClick={() => setSelected(f.path)} title={`${KIND_LABEL[f.kind].text}${f.staged ? " (staged)" : ""}`}>
                  <span className={`kind ${f.kind}`}>{KIND_LABEL[f.kind].letter}</span>
                  <span className="mono git-path">{f.path}</span>
                  {f.staged && <span className="badge">staged</span>}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="git-diff" aria-label="Diff">
          {!selected ? (
            <p className="hint">Los cambios de la tarea aparecerán aquí. La pestaña es de solo lectura: haz commit desde Claude o la shell.</p>
          ) : !diff ? (
            <p className="hint">Cargando diff…</p>
          ) : (
            <>
              {diff.staged && <DiffBlock title="Staged" text={diff.staged} />}
              {diff.unstaged && <DiffBlock title={diff.staged ? "Sin staged" : "Cambios"} text={diff.unstaged} />}
              {!diff.staged && !diff.unstaged && <p className="hint">Sin diferencias que mostrar.</p>}
              {diff.truncated && <p className="callout">Diff recortado: es demasiado grande para mostrarlo entero.</p>}
            </>
          )}
        </section>
      </div>

      <form
        className="git-pr"
        onSubmit={async (e) => {
          e.preventDefault();
          await onSavePrUrl(prUrl.trim());
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
        }}
      >
        <label className="field grow">
          URL del PR <span className="optional">(guárdala cuando exista)</span>
          <input type="url" value={prUrl} onChange={(e) => setPrUrl(e.target.value)} placeholder="https://…" />
        </label>
        <button className="btn" disabled={prUrl.trim() === (task.prUrl ?? "")}>{saved ? "Guardada" : "Guardar"}</button>
        {task.prUrl && <a className="link" href={task.prUrl} target="_blank" rel="noreferrer">Abrir PR</a>}
      </form>
    </div>
  );
}

function DiffBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="diff-block">
      <h4>{title}</h4>
      <pre className="diff">
        {text.split("\n").map((line, i) => (
          <span key={i} className={lineClass(line)}>{line + "\n"}</span>
        ))}
      </pre>
    </div>
  );
}

function lineClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "l meta";
  if (line.startsWith("@@")) return "l hunk";
  if (line.startsWith("+")) return "l add";
  if (line.startsWith("-")) return "l del";
  return "l";
}

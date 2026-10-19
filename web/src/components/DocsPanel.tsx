import { useRef, useState } from "react";
import type { DocInfo } from "../api/types";

interface Props {
  docs: DocInfo[];
  claudeAlive: boolean;
  onAdd: (files: File[]) => void;
  onInsert: (name: string) => void;
  onOpen: (name: string) => void;
  onDelete: (name: string) => Promise<void>;
}

export const fmtSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const fmtDate = (iso: string) => new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function DocsPanel({ docs, claudeAlive, onAdd, onInsert, onOpen, onDelete }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="docs">
      <div className="docs-head">
        <p className="muted">
          Los documentos viven en <span className="mono">.task/</span> del worktree y nunca se suben a git. Arrastra ficheros a cualquier parte de la tarea o añádelos aquí.
        </p>
        <button className="btn primary" onClick={() => input.current?.click()}>Añadir ficheros</button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onAdd([...e.target.files]);
            e.target.value = "";
          }}
        />
      </div>

      {docs.length === 0 ? (
        <div className="docs-empty">
          <p>Esta tarea todavía no tiene documentación.</p>
          <p className="muted">Añade el documento funcional, las specs o capturas para poder pasárselos a Claude con <span className="mono">@</span>.</p>
        </div>
      ) : (
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.name} className="doc-row">
              <div className="doc-info">
                <span className="doc-name mono" title={d.name}>{d.name}</span>
                <span className="muted small">{fmtSize(d.size)} · {fmtDate(d.modified)}</span>
              </div>
              <div className="doc-actions">
                {confirming === d.name ? (
                  <>
                    <span className="small">¿Eliminar {d.name}?</span>
                    <button className="btn danger" onClick={async () => { await onDelete(d.name); setConfirming(null); }}>Eliminar</button>
                    <button className="btn" onClick={() => setConfirming(null)}>Cancelar</button>
                  </>
                ) : (
                  <>
                    <button className="btn" disabled={!claudeAlive} title={claudeAlive ? "Escribe @.task/… en el prompt de Claude, sin Enter" : "Necesitas una sesión de Claude en marcha"} onClick={() => onInsert(d.name)}>
                      Insertar en Claude
                    </button>
                    <button className="btn" onClick={() => onOpen(d.name)}>Abrir</button>
                    <button className="btn danger-ghost" onClick={() => setConfirming(d.name)}>Eliminar</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

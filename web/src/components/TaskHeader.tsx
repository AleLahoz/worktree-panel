import { useState } from "react";
import type { TaskView } from "../api/types";
import { Modal } from "./Modal";
import { ArrowLeft, ArrowUpFromLine, ExternalLink, GitPullRequest, Play, RefreshCw, RotateCcw, Square, TextCursorInput, Trash2 } from "lucide-react";
import { SESSION_LABEL } from "./session";

interface Props {
  task: TaskView;
  busy: boolean;
  claudeAvailable: boolean;
  onBack: () => void;
  onStart: () => void;
  onResume: () => void;
  onStop: () => void;
  onInitialPrompt: () => void;
  onPush: () => void;
  onOpenPr: () => void;
  onClose: (opts: { force: boolean; deleteBranch: boolean }) => Promise<void>;
  onArchive: () => void;
  onRefresh: () => void;
}

export function TaskHeader({ task, busy, claudeAvailable, onBack, onStart, onResume, onStop, onInitialPrompt, onPush, onOpenPr, onClose, onArchive, onRefresh }: Props) {
  const [closing, setClosing] = useState(false);
  const { status, session } = task;
  const alive = session.claude === "running" || session.claude === "waiting";
  const noClaude = !claudeAvailable ? "Claude Code no está instalado o no está en el PATH. Revisa Ajustes." : undefined;

  return (
    <header className="task-header">
      <div className="th-title">
        <button className="icon-btn back" onClick={onBack} aria-label="Volver al tablero" title="Volver al tablero (Esc)"><ArrowLeft size={18} /></button>
        <h1>
          <span className="mono">{task.key}</span>
          {task.title && <span className="th-text">{task.title}</span>}
        </h1>
        {task.jiraUrl && (
          <a className="link" href={task.jiraUrl} target="_blank" rel="noreferrer">Jira <ExternalLink size={12} /></a>
        )}
      </div>

      <div className="th-meta">
        <span className="mono">{task.branch}</span>
        <span className="from" aria-label="sale de">←</span>
        <span className="mono muted">{task.baseRef}</span>
        <span className={`state-pill ${task.lost ? "lost" : session.claude}`}><i className="dot" />{task.lost ? "Worktree perdido" : SESSION_LABEL[session.claude]}</span>
      </div>

      <div className="th-git">
        {status ? (
          <>
            <span>{status.changedFiles} cambios</span>
            <span>{status.unpushed} sin subir</span>
            <span>{status.behindBase} por detrás de la base</span>
            {status.lastCommit && (
              <span className="muted" title={status.lastCommit.subject}>
                Último commit <span className="mono">{status.lastCommit.hash}</span> {status.lastCommit.relative}
              </span>
            )}
          </>
        ) : (
          <span className="muted">Sin estado git</span>
        )}
        <button className="icon-btn sm" onClick={onRefresh} aria-label="Actualizar estado git" title="Actualizar"><RefreshCw size={13} /></button>
      </div>

      <div className="th-actions">
        {task.lost ? (
          <button className="btn" onClick={onArchive}>Archivar tarea</button>
        ) : (
          <>
            {!alive && task.sessionId && (
              <button className="btn primary" disabled={busy || !claudeAvailable} title={noClaude} onClick={onResume}><RotateCcw size={14} />Retomar sesión</button>
            )}
            {!alive && (
              <button className={task.sessionId ? "btn" : "btn primary"} disabled={busy || !claudeAvailable} title={noClaude} onClick={onStart}>
                <Play size={14} />{task.sessionId ? "Nueva sesión" : "Iniciar sesión"}
              </button>
            )}
            {alive && <button className="btn" disabled={busy} onClick={onStop}><Square size={13} />Detener</button>}
            {alive && (
              <button className="btn" disabled={busy} onClick={onInitialPrompt} title="Escribe en la terminal el prompt de la tarea, sin pulsar Enter">
                <TextCursorInput size={14} />Insertar prompt inicial
              </button>
            )}
            <span className="divider" aria-hidden="true" />
            <button className="btn" disabled={busy} onClick={onPush} title={`git push -u origin ${task.branch}`}><ArrowUpFromLine size={14} />Push</button>
            <button className="btn" disabled={busy} onClick={onOpenPr} title={`Abre la página para crear el PR contra ${task.prBase}`}><GitPullRequest size={14} />Abrir PR</button>
            <span className="spacer" />
            <button className="btn danger-ghost" disabled={busy} onClick={() => setClosing(true)}><Trash2 size={14} />Cerrar tarea</button>
          </>
        )}
      </div>

      {closing && (
        <CloseDialog
          task={task}
          onCancel={() => setClosing(false)}
          onConfirm={async (opts) => {
            await onClose(opts);
            setClosing(false);
          }}
        />
      )}
    </header>
  );
}

function CloseDialog({ task, onCancel, onConfirm }: { task: TaskView; onCancel: () => void; onConfirm: (o: { force: boolean; deleteBranch: boolean }) => Promise<void> }) {
  const dirty = task.status?.changedFiles ?? 0;
  const unpushed = task.status?.unpushed ?? 0;
  const risky = dirty > 0 || unpushed > 0;
  const [typed, setTyped] = useState("");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const ok = !risky || typed === task.key;

  const submit = async () => {
    setWorking(true);
    setError("");
    try {
      await onConfirm({ force: risky, deleteBranch });
    } catch (e) {
      setError((e as Error).message);
      setWorking(false);
    }
  };

  return (
    <Modal title={`Cerrar ${task.key}`} onClose={onCancel}>
      <div className="stack">
        <p>
          Se eliminará el worktree <span className="mono">{task.worktreePath}</span>, incluida su carpeta <span className="mono">.task/</span> con los documentos.
          La tarea se archiva y la rama se conserva salvo que marques lo contrario.
        </p>
        {risky && (
          <div className="callout danger">
            <strong>Hay trabajo sin subir.</strong>
            <ul>
              {dirty > 0 && <li>{dirty} ficheros con cambios sin commitear: se perderán.</li>}
              {unpushed > 0 && <li>{unpushed} commits sin subir: solo quedarán en la rama local.</li>}
            </ul>
            <label className="field">
              Escribe <span className="mono">{task.key}</span> para confirmar
              <input value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus />
            </label>
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
          Borrar también la rama local <span className="mono">{task.branch}</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>Cancelar</button>
          <button className="btn danger" disabled={!ok || working} onClick={submit}>{working ? "Cerrando…" : "Cerrar tarea"}</button>
        </div>
      </div>
    </Modal>
  );
}

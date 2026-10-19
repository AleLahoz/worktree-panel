import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Branches, OrphanWorktree, Repo } from "../api/types";
import { Modal } from "./Modal";

interface Props {
  orphan: OrphanWorktree;
  repo: Repo;
  onClose: () => void;
  onImported: (taskId: string) => void;
}

/** Convierte en tarea un worktree de .claude/worktrees/ que el panel no conocía. */
export function ImportModal({ orphan, repo, onClose, onImported }: Props) {
  const [base, setBase] = useState(repo.defaultBase ?? "");
  const [branches, setBranches] = useState<Branches>({ local: [], remote: [] });
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    api.branches(repo.id).then(setBranches).catch((e) => setError(e.message));
  }, [repo.id]);

  const all = [...branches.local, ...branches.remote];
  const valid = !!base && all.includes(base);

  return (
    <Modal title={`Importar ${orphan.key}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setWorking(true);
          setError("");
          try {
            const task = await api.importTask({ repoId: repo.id, key: orphan.key, baseRef: base });
            onImported(task.id);
          } catch (err) {
            setError((err as Error).message);
            setWorking(false);
          }
        }}
      >
        <p>
          Hay un worktree en <span className="mono">{orphan.path}</span>
          {orphan.branch && <> con la rama <span className="mono">{orphan.branch}</span></>} que no está asociado a ninguna tarea.
        </p>
        <label className="field">
          Rama base de la tarea
          <input className="mono" list="import-bases" value={base} onChange={(e) => setBase(e.target.value)} placeholder="Elige de qué rama sale (p. ej. origin/develop)" data-autofocus />
          <datalist id="import-bases">{all.map((b) => <option key={b} value={b} />)}</datalist>
          {!!base && !all.includes(base) && <span className="field-error">Esa rama no existe.</span>}
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={!valid || working}>{working ? "Importando…" : "Importar como tarea"}</button>
        </div>
      </form>
    </Modal>
  );
}

import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Branches, Repo } from "../api/types";
import { Modal } from "./Modal";

interface Props {
  repos: Repo[];
  defaultTemplate: string;
  claudeAvailable: boolean;
  onClose: () => void;
  onCreated: (taskId: string, warnings: string[]) => void;
}

const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function NewTaskModal({ repos, defaultTemplate, claudeAvailable, onClose, onCreated }: Props) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const repo = repos.find((r) => r.id === repoId);
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [jiraUrl, setJiraUrl] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState("");
  const [branchTouched, setBranchTouched] = useState(false);
  const [base, setBase] = useState("");
  const [existing, setExisting] = useState("");
  const [startSession, setStartSession] = useState(claudeAvailable);
  const [branches, setBranches] = useState<Branches>({ local: [], remote: [] });
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [working, setWorking] = useState(false);

  const template = repo?.branchTemplate ?? defaultTemplate;

  useEffect(() => {
    if (!repoId) return;
    setBase(repo?.defaultBase ?? "");
    api.branches(repoId).then(setBranches).catch((e) => setError(e));
  }, [repoId]);

  useEffect(() => {
    if (!branchTouched) setBranch(key ? template.replaceAll("{key}", key) : "");
  }, [key, template, branchTouched]);

  const allBranches = useMemo(() => [...branches.local, ...branches.remote], [branches]);
  const keyOk = KEY_RE.test(key);
  const valid = !!repo && keyOk && (mode === "new" ? !!branch.trim() && allBranches.includes(base) : !!existing);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const res = await api.createTask({
        repoId,
        key,
        title: title.trim() || undefined,
        jiraUrl: jiraUrl.trim() || undefined,
        branch: mode === "new" ? { mode, branch: branch.trim(), base } : { mode, branch: existing, base: base || undefined },
        startSession,
      });
      onCreated(res.task.id, res.warnings);
    } catch (err) {
      setError(err as Error);
      setWorking(false);
    }
  };

  const apiErr = error instanceof ApiError ? error : null;

  return (
    <Modal title="Nueva tarea" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Repositorio
          <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>

        <div className="row">
          <label className="field grow">
            Clave
            <input className="mono" value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="PROJ-123" data-autofocus aria-invalid={!!key && !keyOk} />
            {!!key && !keyOk && <span className="field-error">Solo letras, números, punto, guion y guion bajo.</span>}
          </label>
          <label className="field grow2">
            Título <span className="optional">(opcional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>

        <label className="field">
          URL de Jira <span className="optional">(opcional)</span>
          <input type="url" value={jiraUrl} onChange={(e) => setJiraUrl(e.target.value)} placeholder="https://…" />
        </label>

        <fieldset className="segmented">
          <legend>Rama</legend>
          <label><input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />Nueva rama</label>
          <label><input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} />Rama existente</label>
        </fieldset>

        {mode === "new" ? (
          <>
            <label className="field">
              Nombre de la rama
              <input className="mono" value={branch} onChange={(e) => { setBranch(e.target.value); setBranchTouched(true); }} />
            </label>
            <label className="field">
              Rama base
              <input className="mono" list="base-branches" value={base} onChange={(e) => setBase(e.target.value)} placeholder="Elige de qué rama sale (p. ej. origin/develop)" />
              <datalist id="base-branches">{allBranches.map((b) => <option key={b} value={b} />)}</datalist>
              {!!base && !allBranches.includes(base) && <span className="field-error">Esa rama no existe. Prueba con Fetch en Ajustes si es nueva.</span>}
              {!base && <span className="field-help">No se asume ninguna: elige la rama que usa el cliente como base.</span>}
            </label>
          </>
        ) : (
          <>
            <label className="field">
              Rama existente
              <input className="mono" list="existing-branches" value={existing} onChange={(e) => setExisting(e.target.value)} placeholder="Busca entre las ramas locales y remotas" />
              <datalist id="existing-branches">{allBranches.map((b) => <option key={b} value={b} />)}</datalist>
            </label>
            <label className="field">
              Rama base para el PR <span className="optional">{repo?.defaultBase ? "" : "(obligatoria: el repo no tiene una por defecto)"}</span>
              <input className="mono" list="base-branches" value={base} onChange={(e) => setBase(e.target.value)} />
              <datalist id="base-branches">{allBranches.map((b) => <option key={b} value={b} />)}</datalist>
            </label>
          </>
        )}

        <label className="check">
          <input type="checkbox" checked={startSession} disabled={!claudeAvailable} onChange={(e) => setStartSession(e.target.checked)} />
          Iniciar sesión de Claude al crear
          {!claudeAvailable && <span className="muted"> (Claude Code no está disponible)</span>}
        </label>

        {error && (
          <div className="callout danger" role="alert">
            <p>{error.message}</p>
            {apiErr?.details?.canUseExisting && (
              <button type="button" className="btn" onClick={() => { setMode("existing"); setExisting(apiErr.details.branch); setError(null); }}>
                Usar la rama existente
              </button>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={!valid || working}>{working ? "Creando…" : "Crear tarea"}</button>
        </div>
      </form>
    </Modal>
  );
}

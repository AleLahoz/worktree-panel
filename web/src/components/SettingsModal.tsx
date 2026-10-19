import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AppConfig, EnvCheck, Repo } from "../api/types";
import { Modal } from "./Modal";

interface Props {
  repos: Repo[];
  onClose: () => void;
  onChanged: () => void;
}

export function SettingsModal({ repos, onClose, onChanged }: Props) {
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.envCheck().then(setEnv).catch((e) => setError(e.message));
    api.config().then(setConfig).catch((e) => setError(e.message));
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError("");
    setMsg("");
    try {
      await fn();
      setMsg(ok);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Ajustes" onClose={onClose} wide>
      <div className="stack gap-lg">
        {error && <p className="error" role="alert">{error}</p>}
        {msg && <p className="ok" role="status">{msg}</p>}

        <section className="stack">
          <h3>Entorno</h3>
          {!env ? <p className="muted">Comprobando…</p> : (
            <dl className="env">
              <dt>git</dt><dd className="mono">{env.git ?? "No encontrado"}</dd>
              <dt>node</dt><dd className="mono">{env.node}</dd>
              <dt>claude</dt><dd className="mono">{env.claude ? `${env.claude.version ?? "sin versión"} (${env.claude.path})` : "No encontrado en el PATH"}</dd>
            </dl>
          )}
          {env?.recommendations.map((r) => <p key={r} className="callout">{r}</p>)}
        </section>

        <section className="stack">
          <h3>Repositorios</h3>
          <ul className="repo-settings">
            {repos.map((r) => <RepoRow key={r.id} repo={r} run={run} />)}
            {repos.length === 0 && <li className="muted">Ningún repositorio registrado.</li>}
          </ul>
          <AddRepo run={run} />
        </section>

        {config && (
          <section className="stack">
            <h3>General</h3>
            <ConfigForm config={config} run={run} onSaved={setConfig} />
          </section>
        )}
      </div>
    </Modal>
  );
}

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

function RepoRow({ repo, run }: { repo: Repo; run: Run }) {
  const [base, setBase] = useState(repo.defaultBase ?? "");
  const [setup, setSetup] = useState(repo.setupCommand ?? "");
  const [template, setTemplate] = useState(repo.branchTemplate ?? "");
  const [open, setOpen] = useState(false);
  return (
    <li className="repo-item">
      <div className="row between">
        <div>
          <strong>{repo.name}</strong>
          <div className="mono muted small">{repo.path}</div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => run(() => api.fetchRepo(repo.id), `Fetch de ${repo.name} completado`)}>Fetch</button>
          <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>Configurar</button>
          <button className="btn danger-ghost" onClick={() => confirm(`¿Quitar ${repo.name} del panel? No se borra nada en disco.`) && run(() => api.deleteRepo(repo.id), `${repo.name} quitado`)}>Quitar</button>
        </div>
      </div>
      {open && (
        <form className="stack config" onSubmit={(e) => { e.preventDefault(); run(() => api.updateRepo(repo.id, { defaultBase: base || undefined, setupCommand: setup || undefined, branchTemplate: template || undefined }), "Repositorio guardado"); }}>
          <label className="field">Rama base sugerida<input className="mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="origin/develop" /></label>
          <label className="field">Plantilla de rama<input className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="feature/{key}" /></label>
          <label className="field">Comando de preparación <span className="optional">(se ejecuta en la shell al crear la tarea)</span><input className="mono" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="npm ci" /></label>
          <div className="modal-actions"><button className="btn primary">Guardar</button></div>
        </form>
      )}
    </li>
  );
}

function AddRepo({ run }: { run: Run }) {
  const [path, setPath] = useState("");
  const [base, setBase] = useState("");
  return (
    <form
      className="stack config"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => api.addRepo({ path, defaultBase: base || undefined }), "Repositorio añadido").then(() => { setPath(""); setBase(""); });
      }}
    >
      <label className="field">Ruta del repositorio<input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Proyectos\mi-repo" /></label>
      <label className="field">Rama base sugerida <span className="optional">(opcional)</span><input className="mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="origin/develop" /></label>
      <div className="modal-actions"><button className="btn primary" disabled={!path.trim()}>Añadir repositorio</button></div>
    </form>
  );
}

function ConfigForm({ config, run, onSaved }: { config: AppConfig; run: Run; onSaved: (c: AppConfig) => void }) {
  const [c, setC] = useState(config);
  return (
    <form className="stack config" onSubmit={(e) => { e.preventDefault(); run(async () => onSaved(await api.saveConfig(c)), "Ajustes guardados"); }}>
      <label className="field">Ruta de Claude Code <span className="optional">(vacío = detectar con where)</span><input className="mono" value={c.claudePath} onChange={(e) => setC({ ...c, claudePath: e.target.value })} /></label>
      <label className="field">Shell<input className="mono" value={c.shellPath} onChange={(e) => setC({ ...c, shellPath: e.target.value })} placeholder="powershell.exe" /></label>
      <label className="field">Plantilla de rama por defecto<input className="mono" value={c.defaultBranchTemplate} onChange={(e) => setC({ ...c, defaultBranchTemplate: e.target.value })} /></label>
      <label className="field">
        Prompt inicial <span className="optional">(variables: {"{key} {title_suffix} {branch} {base} {doc_refs}"})</span>
        <textarea rows={6} value={c.initialPromptTemplate} onChange={(e) => setC({ ...c, initialPromptTemplate: e.target.value })} />
      </label>
      <div className="modal-actions"><button className="btn primary">Guardar ajustes</button></div>
    </form>
  );
}

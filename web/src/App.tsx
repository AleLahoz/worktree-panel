import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api/client";
import type { AppConfig, EnvCheck, Repo, TaskView } from "./api/types";
import { NewTaskModal } from "./components/NewTaskModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { TaskHeader } from "./components/TaskHeader";
import { TerminalView } from "./components/TerminalView";

type Tab = "claude" | "shell";

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<Tab>("claude");
  const [filter, setFilter] = useState("");
  const [modal, setModal] = useState<"new" | "settings" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [connectKey, setConnectKey] = useState({ claude: 0, shell: 0 });
  const [loaded, setLoaded] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, t] = await Promise.all([api.repos(), api.tasks()]);
      setRepos(r);
      setTasks(t);
    } catch (e) {
      setNotice({ kind: "error", text: `No se pudo contactar con el backend: ${(e as Error).message}` });
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadEnv = useCallback(() => {
    api.envCheck().then(setEnv).catch(() => {});
    api.config().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    loadEnv();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh, loadEnv]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key.toLowerCase() === "n" && repos.length) {
        e.preventDefault();
        setModal("new");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [repos.length]);

  const task = useMemo(() => tasks.find((t) => t.id === selectedId), [tasks, selectedId]);
  useEffect(() => {
    if (selectedId && loaded && !task) setSelectedId(undefined);
  }, [selectedId, loaded, task]);

  const bump = (kind: Tab) => setConnectKey((k) => ({ ...k, [kind]: k[kind] + 1 }));
  const fail = (e: unknown) => setNotice({ kind: "error", text: (e as Error).message });

  /** Ejecuta una acción sobre la tarea, refresca y reconecta la terminal indicada. */
  const act = async (fn: () => Promise<unknown>, reconnect?: Tab) => {
    setBusy(true);
    try {
      await fn();
      if (reconnect) bump(reconnect);
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const claudeAvailable = env?.claudeAvailable ?? true;
  const empty = (kind: Tab) => {
    if (!task) return null;
    const state = task.session[kind];
    if (kind === "shell") {
      return (
        <>
          <p>La shell de esta tarea está cerrada.</p>
          <button className="btn primary" disabled={busy} onClick={() => act(() => api.startShell(task.id), "shell")}>Abrir shell</button>
        </>
      );
    }
    if (state === "stopped") {
      return (
        <>
          <p>La sesión se detuvo, pero puedes continuar la misma conversación.</p>
          <div className="row">
            <button className="btn primary" disabled={busy || !claudeAvailable} onClick={() => act(() => api.resumeSession(task.id), "claude")}>Retomar sesión</button>
            <button className="btn" disabled={busy || !claudeAvailable} onClick={() => act(() => api.startSession(task.id), "claude")}>Nueva sesión</button>
          </div>
        </>
      );
    }
    return (
      <>
        <p>Esta tarea aún no tiene una sesión de Claude.</p>
        <button className="btn primary" disabled={busy || !claudeAvailable} onClick={() => act(() => api.startSession(task.id), "claude")}>Iniciar sesión</button>
      </>
    );
  };

  return (
    <div className="app">
      <Sidebar
        repos={repos}
        tasks={tasks}
        selectedId={selectedId}
        filter={filter}
        onFilter={setFilter}
        onSelect={(id) => { setSelectedId(id); setTab("claude"); }}
        onNew={() => (repos.length ? setModal("new") : setModal("settings"))}
        onSettings={() => setModal("settings")}
        filterRef={filterRef}
      />

      <main className="main">
        {!task ? (
          <div className="welcome">
            <h1>Worktree Panel</h1>
            {repos.length === 0 ? (
              <>
                <p>Cada tarea de Jira vive en su propio worktree, con su documentación y su sesión de Claude Code.</p>
                <button className="btn primary" onClick={() => setModal("settings")}>Añadir un repositorio</button>
              </>
            ) : (
              <>
                <p>{tasks.length ? "Elige una tarea en la barra lateral o crea otra." : "Todavía no hay tareas."}</p>
                <button className="btn primary" onClick={() => setModal("new")}>Nueva tarea</button>
              </>
            )}
          </div>
        ) : (
          <>
            <TaskHeader
              task={task}
              busy={busy}
              claudeAvailable={claudeAvailable}
              onStart={() => act(() => api.startSession(task.id), "claude")}
              onResume={() => act(() => api.resumeSession(task.id), "claude")}
              onStop={() => act(() => api.stopSession(task.id))}
              onInitialPrompt={() => act(() => api.initialPrompt(task.id))}
              onClose={async (opts) => {
                await api.closeTask(task.id, opts);
                setSelectedId(undefined);
                await refresh();
              }}
              onArchive={() => act(async () => { await api.archiveTask(task.id); setSelectedId(undefined); })}
              onRefresh={refresh}
            />

            <div className="tabs" role="tablist">
              {(["claude", "shell"] as Tab[]).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>
                  {k === "claude" ? "Claude" : "Shell"}
                </button>
              ))}
            </div>

            {task.lost ? (
              <div className="empty-state">
                <p>Git ya no registra este worktree o se borró su directorio. Puedes archivar la tarea; la rama sigue en el repositorio.</p>
              </div>
            ) : (
              (["claude", "shell"] as Tab[]).map((k) => (
                <TerminalView
                  key={`${task.id}:${k}`}
                  taskId={task.id}
                  kind={k}
                  connectKey={connectKey[k]}
                  visible={tab === k}
                  empty={empty(k)}
                  onExit={refresh}
                  onStatus={refresh}
                />
              ))
            )}
          </>
        )}
      </main>

      {notice && (
        <div className={`toast ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Descartar">×</button>
        </div>
      )}

      {modal === "new" && (
        <NewTaskModal
          repos={repos}
          defaultTemplate={config?.defaultBranchTemplate ?? "feature/{key}"}
          claudeAvailable={claudeAvailable}
          onClose={() => setModal(null)}
          onCreated={async (id, warnings) => {
            setModal(null);
            await refresh();
            setSelectedId(id);
            setTab("claude");
            bump("claude");
            bump("shell");
            if (warnings.length) setNotice({ kind: "info", text: warnings.join(" ") });
          }}
        />
      )}
      {modal === "settings" && <SettingsModal repos={repos} onClose={() => { setModal(null); loadEnv(); }} onChanged={refresh} />}
    </div>
  );
}

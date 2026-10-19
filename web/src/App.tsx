import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api/client";
import type { AppConfig, DocInfo, EnvCheck, Repo, TaskView } from "./api/types";
import { DocsPanel } from "./components/DocsPanel";
import { DropOverlay } from "./components/DropOverlay";
import { NewTaskModal } from "./components/NewTaskModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { TaskHeader } from "./components/TaskHeader";
import { TerminalView } from "./components/TerminalView";

type Tab = "claude" | "shell" | "docs";
const MAX_DOC_BYTES = 50 * 1024 * 1024;

interface Notice {
  kind: "error" | "info";
  text: string;
  action?: { label: string; run: () => void };
}

const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");

export function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [docs, setDocs] = useState<DocInfo[]>([]);
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<Tab>("claude");
  const [filter, setFilter] = useState("");
  const [modal, setModal] = useState<"new" | "settings" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [connectKey, setConnectKey] = useState({ claude: 0, shell: 0 });
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Al incrementarlo, la terminal de Claude recupera el foco (tras insertar texto desde la UI). */
  const [focusClaude, setFocusClaude] = useState(0);
  const dragDepth = useRef(0);
  const filterRef = useRef<HTMLInputElement>(null);

  const task = useMemo(() => tasks.find((t) => t.id === selectedId), [tasks, selectedId]);
  const taskId = task?.id;

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

  const refreshDocs = useCallback(async () => {
    if (!taskId) return setDocs([]);
    try {
      setDocs(await api.docs(taskId));
    } catch {
      /* la tarea pudo cerrarse entre medias */
    }
  }, [taskId]);

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
    setDocs([]);
    refreshDocs();
    const id = window.setInterval(refreshDocs, 5000);
    return () => window.clearInterval(id);
  }, [refreshDocs]);

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

  useEffect(() => {
    if (selectedId && loaded && !task) setSelectedId(undefined);
  }, [selectedId, loaded, task]);

  const bump = (kind: "claude" | "shell") => setConnectKey((k) => ({ ...k, [kind]: k[kind] + 1 }));
  const fail = (e: unknown) => setNotice({ kind: "error", text: (e as Error).message });
  const claudeAlive = task?.session.claude === "running" || task?.session.claude === "waiting";

  /** Ejecuta una acción sobre la tarea, refresca y reconecta la terminal indicada. */
  const act = async (fn: () => Promise<unknown>, reconnect?: "claude" | "shell") => {
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

  /** Escribe en la pty de Claude (sin Enter) y lleva al usuario a su pestaña para completar el mensaje. */
  const insertRefs = async (names: string[]) => {
    if (!task) return;
    try {
      // Espacio delante: el prompt inicial no termina en espacio y la referencia quedaría pegada a la última palabra.
      await api.insert(task.id, ` ${names.map((n) => `@.task/${n}`).join(" ")} `);
      setTab("claude");
      setNotice(null);
      setFocusClaude((n) => n + 1);
    } catch (e) {
      fail(e);
    }
  };

  const addDocs = async (files: File[]) => {
    if (!task || !files.length) return;
    const tooBig = files.find((f) => f.size > MAX_DOC_BYTES);
    if (tooBig) return setNotice({ kind: "error", text: `${tooBig.name} supera el máximo de 50 MB.` });
    try {
      const saved = await api.uploadDocs(task.id, files);
      await refreshDocs();
      const warnings = [...new Set(saved.map((s) => s.warning).filter(Boolean))].join(" ");
      const names = saved.map((s) => s.name);
      const text = `${names.length === 1 ? `Añadido ${names[0]}` : `Añadidos ${names.length} ficheros`} a .task/.${warnings ? ` ${warnings}` : ""}`;
      setNotice({
        kind: "info",
        text: claudeAlive ? `${text} ¿Insertar la referencia en Claude?` : text,
        action: claudeAlive ? { label: "Insertar en Claude", run: () => insertRefs(names) } : undefined,
      });
    } catch (e) {
      fail(e);
    }
  };

  const dragProps = task && !task.lost
    ? {
        onDragEnter: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (e: React.DragEvent) => hasFiles(e) && e.preventDefault(),
        onDragLeave: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          if (--dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        },
        onDrop: (e: React.DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          addDocs([...e.dataTransfer.files]);
        },
      }
    : {};

  const emptyFor = (kind: "claude" | "shell") => {
    if (!task) return null;
    if (kind === "shell") {
      return (
        <>
          <p>La shell de esta tarea está cerrada.</p>
          <button className="btn primary" disabled={busy} onClick={() => act(() => api.startShell(task.id), "shell")}>Abrir shell</button>
        </>
      );
    }
    if (task.session.claude === "stopped") {
      return (
        <>
          <p>La sesión se detuvo, pero puedes continuar la misma conversación.</p>
          <div className="row">
            <button className="btn primary" disabled={busy || !env?.claudeAvailable} onClick={() => act(() => api.resumeSession(task.id), "claude")}>Retomar sesión</button>
            <button className="btn" disabled={busy || !env?.claudeAvailable} onClick={() => act(() => api.startSession(task.id), "claude")}>Nueva sesión</button>
          </div>
        </>
      );
    }
    return (
      <>
        <p>Esta tarea aún no tiene una sesión de Claude.</p>
        <button className="btn primary" disabled={busy || !env?.claudeAvailable} onClick={() => act(() => api.startSession(task.id), "claude")}>Iniciar sesión</button>
      </>
    );
  };

  const claudeAvailable = env?.claudeAvailable ?? true;

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

      <main className="main" {...dragProps}>
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
              onInitialPrompt={() => act(async () => { await api.initialPrompt(task.id); setTab("claude"); setFocusClaude((n) => n + 1); })}
              onClose={async (opts) => {
                await api.closeTask(task.id, opts);
                setSelectedId(undefined);
                await refresh();
              }}
              onArchive={() => act(async () => { await api.archiveTask(task.id); setSelectedId(undefined); })}
              onRefresh={refresh}
            />

            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "claude"} className={tab === "claude" ? "tab active" : "tab"} onClick={() => setTab("claude")}>Claude</button>
              <button role="tab" aria-selected={tab === "shell"} className={tab === "shell" ? "tab active" : "tab"} onClick={() => setTab("shell")}>Shell</button>
              <button role="tab" aria-selected={tab === "docs"} className={tab === "docs" ? "tab active" : "tab"} onClick={() => setTab("docs")}>
                Documentos{docs.length ? ` (${docs.length})` : ""}
              </button>
            </div>

            {task.lost ? (
              <div className="empty-state">
                <p>Git ya no registra este worktree o se borró su directorio. Puedes archivar la tarea; la rama sigue en el repositorio.</p>
              </div>
            ) : (
              <>
                {(["claude", "shell"] as const).map((k) => (
                  <TerminalView
                    key={`${task.id}:${k}`}
                    taskId={task.id}
                    kind={k}
                    connectKey={connectKey[k]}
                    focusSignal={k === "claude" ? focusClaude : 0}
                    visible={tab === k}
                    empty={emptyFor(k)}
                    onExit={refresh}
                    onStatus={refresh}
                  />
                ))}
                {tab === "docs" && (
                  <DocsPanel
                    docs={docs}
                    claudeAlive={!!claudeAlive}
                    onAdd={addDocs}
                    onInsert={(name) => insertRefs([name])}
                    onOpen={(name) => api.openDoc(task.id, name).catch(fail)}
                    onDelete={async (name) => {
                      try {
                        await api.deleteDoc(task.id, name);
                        await refreshDocs();
                      } catch (e) {
                        fail(e);
                      }
                    }}
                  />
                )}
              </>
            )}
            {dragging && <DropOverlay taskKey={task.key} />}
          </>
        )}
      </main>

      {notice && (
        <div className={`toast ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          <span>{notice.text}</span>
          {notice.action && <button className="btn" onClick={notice.action.run}>{notice.action.label}</button>}
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

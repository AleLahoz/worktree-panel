import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  taskId: string;
  kind: "claude" | "shell";
  /** Cambia cuando el usuario inicia/retoma: fuerza una nueva conexión. */
  connectKey: number;
  /** Al cambiar, la terminal toma el foco del teclado. */
  focusSignal?: number;
  visible: boolean;
  /** Se muestra cuando no hay terminal viva en el backend. */
  empty: ReactNode;
  onExit?: () => void;
  onStatus?: () => void;
}

const THEME = {
  background: "#0d151a",
  foreground: "#dde5e2",
  cursor: "#e9b44c",
  selectionBackground: "#2c4650",
  black: "#17252c", brightBlack: "#5b7078",
  red: "#e0675f", green: "#4db6a4", yellow: "#e9b44c", blue: "#6aa2d8", magenta: "#b58ad8", cyan: "#58c4d4", white: "#dde5e2",
  brightRed: "#f08a82", brightGreen: "#7fd0c1", brightYellow: "#f3c970", brightBlue: "#8bbbe8", brightMagenta: "#cba6e6", brightCyan: "#85d6e2", brightWhite: "#ffffff",
};

/** xterm.js conectado por WebSocket a la pty de la tarea. Al reconectar, el backend reenvía el buffer. */
export function TerminalView({ taskId, kind, connectKey, focusSignal = 0, visible, empty, onExit, onStatus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const cb = useRef({ onExit, onStatus });
  cb.current = { onExit, onStatus };

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | undefined;
    let retry: number | undefined;
    setUnavailable(false);

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
    };
    const doFit = () => {
      if (!host.current || host.current.clientWidth === 0) return;
      try {
        fit.fit();
        sendResize();
      } catch {
        /* contenedor aún sin tamaño */
      }
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/pty/${taskId}/${kind}`);
      let first = true;
      ws.onopen = () => doFit();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === "out") {
          if (first) {
            term.reset(); // el backend reenvía el buffer completo en cada conexión
            first = false;
          }
          term.write(m.d);
        } else if (m.t === "exit") {
          term.write(`\r\n\x1b[90m[Proceso terminado, código ${m.code}]\x1b[0m\r\n`);
          cb.current.onExit?.();
        } else if (m.t === "status") cb.current.onStatus?.();
      };
      ws.onclose = (e) => {
        if (disposed) return;
        if (e.code === 4404) setUnavailable(true);
        else retry = window.setTimeout(connect, 1500);
      };
    };
    connect();

    const input = term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "in", d })));
    const ro = new ResizeObserver(doFit);
    ro.observe(host.current!);

    return () => {
      disposed = true;
      window.clearTimeout(retry);
      ro.disconnect();
      input.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [taskId, kind, connectKey]);

  useEffect(() => {
    if (visible && !unavailable) {
      // `focusSignal` está en las dependencias: cada incremento vuelve a enfocar.
      fitRef.current?.fit();
      termRef.current?.focus();
    }
  }, [visible, unavailable, focusSignal]);

  return (
    <div className="terminal-wrap" hidden={!visible}>
      <div ref={host} className="terminal" hidden={unavailable} />
      {unavailable && <div className="empty-state">{empty}</div>}
    </div>
  );
}

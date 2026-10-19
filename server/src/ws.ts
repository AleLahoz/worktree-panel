import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { isAllowedHost, isAllowedOrigin } from "./app.js";
import type { PtyKind, PtyManager } from "./services/PtyManager.js";

const PATH_RE = /^\/ws\/pty\/([^/]+)\/(claude|shell)$/;

/** WebSocket /ws/pty/:taskId/:kind. Cliente→servidor: {t:"in",d} y {t:"resize",cols,rows}. */
export function attachWebSocket(server: Server, ptys: PtyManager, port: number) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const match = PATH_RE.exec(new URL(req.url ?? "", "http://x").pathname);
    if (!match || !isAllowedHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    const [, taskId, kind] = match;
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ptys, taskId, kind as PtyKind));
  });

  return wss;
}

function onConnection(ws: WebSocket, ptys: PtyManager, taskId: string, kind: PtyKind) {
  const pty = ptys.get(taskId, kind);
  if (!pty) return ws.close(4404, "No hay terminal para esta tarea");

  const client = { send: (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)) };
  pty.attach(client);

  ws.on("message", (raw) => {
    let msg: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === "in" && typeof msg.d === "string") pty.write(msg.d);
    else if (msg.t === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) pty.resize(msg.cols as number, msg.rows as number);
  });
  ws.on("close", () => pty.detach(client));
  ws.on("error", () => pty.detach(client));
}

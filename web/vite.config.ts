import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BACKEND = "http://127.0.0.1:4317";
// El backend solo acepta Host/Origin locales de su propio puerto: en desarrollo el proxy los reescribe.
const rewriteOrigin = (proxy: any) => {
  proxy.on("proxyReq", (req: any) => req.setHeader("origin", BACKEND));
  proxy.on("proxyReqWs", (req: any) => req.setHeader("origin", BACKEND));
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, configure: rewriteOrigin },
      "/ws": { target: BACKEND, changeOrigin: true, ws: true, configure: rewriteOrigin },
    },
  },
});

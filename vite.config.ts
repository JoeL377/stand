import net from "node:net";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = 3001;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "localhost" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

// `npm run dev` starts Vite and the API server together, and Vite is ready
// first (the server also restarts on every save). Hold /api requests until
// the server is listening instead of failing them with ECONNREFUSED.
function waitForApi(): Plugin {
  return {
    name: "wait-for-api",
    configureServer(server) {
      server.middlewares.use(async (req, _res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        for (let i = 0; i < 100 && !(await portOpen(API_PORT)); i++) await new Promise((r) => setTimeout(r, 150));
        next();
      });
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), waitForApi()],
  build: { outDir: "../../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host so links the server builds (the meeting brief) point here.
      "^/api/": { target: `http://localhost:${API_PORT}`, changeOrigin: false },
      "^/ws/": { target: `ws://localhost:${API_PORT}`, ws: true },
    },
  },
});

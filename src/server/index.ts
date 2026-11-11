import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { type WebSocket, WebSocketServer } from "ws";
import { authRoutes, requireUser, userFromRequest } from "./auth.ts";
import { capabilities, config } from "./config.ts";
import { conxtRoutes } from "./conxt.ts";
import { oauthRoutes } from "./oauth.ts";
import { startServices } from "./services.ts";
import { brainstormRoutes } from "./routes/brainstorms.ts";
import { deckRoutes } from "./routes/decks.ts";
import { designReviewRoutes } from "./routes/designReviews.ts";
import { githubRoutes, githubWebhook } from "./routes/github.ts";
import { jotRoutes } from "./routes/jots.ts";
import { meetingRoutes } from "./routes/meetings.ts";
import { openRoutes } from "./routes/open.ts";
import { projectRoutes } from "./routes/projects.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { snapRoutes } from "./routes/snaps.ts";
import { spaceRoutes } from "./routes/spaces.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { tokenRoutes } from "./routes/tokens.ts";

const services = startServices();
const { db, session, githubApp } = services;

const app = express();
// GitHub's signature is checked against the raw body, so its webhook comes before the JSON parser.
githubWebhook(app, services);
app.use(express.json({ limit: "1mb" }));

// For the host's health check: up and able to read the database.
app.get("/api/health", (_req, res) => {
  db.getRoom("health");
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json(capabilities());
});
app.use("/api/auth", authRoutes(db));
// Sign-in for agents that connect with just the /mcp URL (Claude custom connectors).
app.use(oauthRoutes(db));
openRoutes(app, services);

// Everything else needs a signed-in user.
app.use("/api", requireUser(db));
taskRoutes(app, services);
githubRoutes(app, services);
projectRoutes(app, services);
app.use("/api/rooms/:id/conxt", conxtRoutes(db, services.conxtDestinations));
snapRoutes(app, services);
jotRoutes(app, services);
tokenRoutes(app, services);
spaceRoutes(app, services);
deckRoutes(app, services);
brainstormRoutes(app, services);
reviewRoutes(app, services);
designReviewRoutes(app, services);
meetingRoutes(app, services);

// Serve the built web app in production.
const dist = path.resolve("dist");
if (config.production && fs.existsSync(dist)) {
  app.use(express.static(dist));
  // root: a path given whole is refused when a folder above it starts with a dot (a worktree under ~/.local).
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile("index.html", { root: dist }));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const m = req.url?.match(/^\/ws\/rooms\/([a-z0-9]+)$/);
  const user = userFromRequest(db, req);
  const s = m && user ? session(m[1]) : null;
  if (!s || !user) {
    socket.write(user ? "HTTP/1.1 404 Not Found\r\n\r\n" : "HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  db.touchMembership(s.roomId, user.id);
  wss.handleUpgrade(req, socket, head, (ws) => {
    answering.add(ws);
    ws.on("pong", () => answering.add(ws));
    s.attach(ws, user);
  });
});

// A connection that stops answering pings (a laptop lid shut, Wi-Fi gone) is
// dropped, so its person leaves the room and the host seat can pass on.
const answering = new WeakSet<WebSocket>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (!answering.has(ws)) {
      ws.terminate();
      continue;
    }
    answering.delete(ws);
    ws.ping();
  }
}, 30_000).unref();

server.listen(config.port, () => {
  const c = capabilities();
  console.log(`standup server on http://localhost:${config.port}`);
  console.log(
    `  audio: ${c.livekit ? "LiveKit" : "off (mock mode)"} · transcription: ${c.transcription} · notes: ${c.llm ? `${config.notesModel} (tidy: ${config.notesTidyModel})` : "heuristic"} · Linear: ${c.linear ? "on" : "off"} · GitHub app: ${githubApp ? "on" : "off"}`,
  );
});

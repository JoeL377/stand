// Brainstorms and design sessions: a call that starts from one sentence and draws what's said.
import type { Express } from "express";
import { BrainstormError, brainstormPage, brainstormsOf, starIdea, startBrainstorm, toBrainstormView } from "../brainstorm.ts";
import { isDiagramText, mermaidIn, parseSeed, SEED_MAX, seedFromAnswer } from "../designSession.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function brainstormRoutes(app: Express, ctx: Services) {
  const { db, agent, sessions } = ctx;
  // Opens a map or a diagram on a topic or a question, for the call that is running or the next one.
  app.post(
    "/api/rooms/:id/brainstorm/start",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      try {
        // A design session (designSession.ts) when the body carries `design`: it may start from pasted
        // notes or a diagram, or from the plan of the to-do its draft spec will be saved on.
        const asked = req.body?.design as { seed?: unknown; taskId?: unknown } | undefined;
        let design: Parameters<typeof startBrainstorm>[5];
        let prompt = String(req.body?.prompt ?? "");
        if (asked) {
          const task = typeof asked.taskId === "string" && asked.taskId ? db.getNote(asked.taskId) : null;
          if (asked.taskId && (!task || task.roomId !== room.id || task.kind !== "action")) throw new BrainstormError("That to-do isn't in this space.");
          const pasted = String(asked.seed ?? "").trim().slice(0, SEED_MAX);
          const plan = !pasted && task ? (db.notePlan(task.id)?.text ?? "") : "";
          const seed = pasted || plan;
          // No topic given: the to-do's, or the heading the notes open with. Otherwise it starts
          // untitled and the talk names it.
          prompt = String(req.body?.prompt ?? "").trim() || task?.text || /^\s*#{1,3}\s+(.+)$/m.exec(pasted)?.[1]?.trim() || "";
          let diagram = parseSeed(pasted ? (isDiagramText(pasted) ? pasted : "") : mermaidIn(plan));
          // Prose, or a plan with no diagram in it: the model finds the design. Without it the session starts blank.
          if (seed && !diagram.boxes.length && agent.designSeed) diagram = seedFromAnswer(await agent.designSeed(prompt || "not named yet", seed).catch(() => null));
          if (pasted && !diagram.boxes.length) diagram = parseSeed(pasted);
          design = { diagram, seed: seed || null, taskId: task?.id ?? null };
        }
        // In a call it opens as a view beside the board: the agenda, the focus and the host stay as they are.
        const s = sessions.get(room.id);
        const b = s && !s.ended ? s.openView(prompt, req.user!.name, design) : startBrainstorm(db, room.id, prompt, req.user!.name, Date.now(), design);
        res.json({ brainstorm: toBrainstormView(b) });
      } catch (err) {
        if (err instanceof BrainstormError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  // "Finish this": the host ends the review running in the call, and the call goes on as plain talk.
  app.post(
    "/api/rooms/:id/experience/finish",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const s = sessions.get(room.id);
      if (!s) return void res.status(409).json({ error: "No call is running in this space." });
      if (!s.hostIs(req.user!.id)) return void res.status(403).json({ error: "Only the host can finish it." });
      res.json({ finished: await s.finishExperience() });
    }),
  );

  // One brainstorm's own page.
  app.get(
    "/api/rooms/:id/brainstorms/:brainstormId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const brainstorm = brainstormPage(db, room.id, req.params.brainstormId);
      if (!brainstorm) return notFound(res, "Brainstorm not found");
      res.json({ roomName: room.name, brainstorm, brainstorms: brainstormsOf(db, room.id) });
    }),
  );

  // Star an idea on a brainstorm's page, or take the star off.
  app.post(
    "/api/rooms/:id/brainstorms/:brainstormId/star",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const brainstorm = starIdea(db, room.id, req.params.brainstormId, String(req.body?.idea ?? ""), req.body?.on !== false);
      if (!brainstorm) return notFound(res, "Idea not found");
      res.json({ brainstorm });
    }),
  );
}

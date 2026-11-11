// Brainstorms and design sessions: a call that starts from one sentence and draws what's said.
import type { Express } from "express";
import { BrainstormError, brainstormPage, brainstormsOf, starIdea, startBrainstorm, toBrainstormView } from "../brainstorm.ts";
import { isDiagramText, mermaidIn, parseSeed, SEED_MAX, seedFromAnswer } from "../designSession.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function brainstormRoutes(app: Express, ctx: Services) {
  const { db, agent, sessions } = ctx;
  // Starts one on a topic or a question. It leads the agenda, and a call that's running goes to it.
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
        if (asked) {
          const prompt = String(req.body?.prompt ?? "").trim();
          if (!prompt) throw new BrainstormError("Say what you're designing, in a sentence.");
          const task = typeof asked.taskId === "string" && asked.taskId ? db.getNote(asked.taskId) : null;
          if (asked.taskId && (!task || task.roomId !== room.id || task.kind !== "action")) throw new BrainstormError("That to-do isn't in this space.");
          const pasted = String(asked.seed ?? "").trim().slice(0, SEED_MAX);
          const plan = !pasted && task ? (db.notePlan(task.id)?.text ?? "") : "";
          const seed = pasted || plan;
          let diagram = parseSeed(pasted ? (isDiagramText(pasted) ? pasted : "") : mermaidIn(plan));
          // Prose, or a plan with no diagram in it: the model finds the design. Without it the session starts blank.
          if (seed && !diagram.boxes.length && agent.designSeed) diagram = seedFromAnswer(await agent.designSeed(prompt, seed).catch(() => null));
          if (pasted && !diagram.boxes.length) diagram = parseSeed(pasted);
          design = { diagram, seed: seed || null, taskId: task?.id ?? null };
        }
        const b = startBrainstorm(db, room.id, String(req.body?.prompt ?? ""), req.user!.name, Date.now(), design);
        const s = sessions.get(room.id);
        if (s) {
          s.itemsChanged();
          s.brainstormChanged();
          if (b.itemId) s.setFocus(b.itemId, req.user!.name, "manual");
        }
        res.json({ brainstorm: toBrainstormView(b) });
      } catch (err) {
        if (err instanceof BrainstormError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  // "Finish this": the host ends the review, brainstorm or design session running in the call, and the
  // call goes on as plain talk.
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

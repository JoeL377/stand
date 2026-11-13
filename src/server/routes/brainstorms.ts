// Brainstorms and design sessions: a map or a diagram of what's said in a call, drawn from one sentence.
import type { Express } from "express";
import { BrainstormError, brainstormPage, brainstormsOf, promptOf, starIdea, startBrainstorm, toBrainstormView } from "../brainstorm.ts";
import { isDiagramText, mermaidIn, parseSeed, SEED_MAX, seedFromAnswer } from "../designSession.ts";
import type { Services } from "../services.ts";
import { forSpace } from "../usage.ts";
import { memberRoom, notFound, route } from "./http.ts";

export function brainstormRoutes(app: Express, ctx: Services) {
  const { db, agent, sessions } = ctx;
  // Starts one on a topic or a question. A call that's running draws its map or diagram beside the board.
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
          if (seed && !diagram.boxes.length && agent.designSeed) diagram = seedFromAnswer(await forSpace(agent, room.id).designSeed!(prompt || "not named yet", seed).catch(() => null));
          if (pasted && !diagram.boxes.length) diagram = parseSeed(pasted);
          design = { diagram, seed: seed || null, taskId: task?.id ?? null };
        }
        // A sketch (sketch.ts) can open with nothing typed: the talk names it. `style` is how its first
        // subject is drawn to begin with, when whoever opened it knows; a map otherwise.
        const sketch = req.body?.sketch === true;
        if (!design && req.body?.style === "diagram") design = { diagram: { boxes: [], arrows: [] }, seed: null, taskId: null };
        const s = sessions.get(room.id);
        const text = promptOf(prompt, !!design || sketch);
        const live = db.brainstormLive(room.id);
        // One is already on in the call. Opening the sketch again is the same sketch; only one started
        // from notes, a diagram or a to-do takes its place, and then it stops first, so it is kept as
        // it would be by Stop drawing.
        const fromSomething = !!design && (!!design.seed || !!design.taskId || design.diagram.boxes.length > 0);
        if (s && live && !fromSomething) {
          s.present(req.user!.id, "sketch");
          return void res.json({ brainstorm: toBrainstormView(live) });
        }
        if (s && text && live && !(live.prompt === text && (live.kind === "design") === !!design)) await s.stopView();
        const b = startBrainstorm(db, room.id, text, req.user!.name, Date.now(), design);
        if (s) {
          s.itemsChanged();
          s.brainstormChanged();
          // Whoever starts it in the call presents it: everyone's board goes to it.
          s.present(req.user!.id, "sketch");
        }
        res.json({ brainstorm: toBrainstormView(b) });
      } catch (err) {
        if (err instanceof BrainstormError) return res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  // "Finish this": someone in the call ends the review running in the call, and the call goes on as plain talk.
  app.post(
    "/api/rooms/:id/experience/finish",
    route(async (req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const s = sessions.get(room.id);
      if (!s) return void res.status(409).json({ error: "No call is running in this space." });
      // Anyone in the call can finish it, as anyone can call a slide's outcome.
      if (!s.has(req.user!.id)) return void res.status(403).json({ error: "Join the call to finish it." });
      res.json({ finished: await s.finishExperience({ id: req.user!.id, name: req.user!.name }) });
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

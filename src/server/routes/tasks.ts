// To-dos and open questions: their drawer, comments, work logs, plan reviews and state.
import type { Express } from "express";
import { type ActionWork, TASK_COMMENT_MAX, type TaskDetail, type TaskLink } from "../../shared/protocol.ts";
import { stateOf } from "../../shared/tasks.ts";
import { AgentError } from "../agents.ts";
import type { DB } from "../db.ts";
import { mentionView, recordMentions } from "../mentions.ts";
import { changeReview, logThreadChange, reviewFor } from "../planReview.ts";
import { readyToShip, workingOn, workLog } from "../workLog.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

export function taskRoutes(app: Express, ctx: Services) {
  const { db, planBriefs, sessions, doneDecks, agents, specTouched } = ctx;
  // Whether an agent is on each of these to-dos, and what's been reported on them. ?ids=a,b,c
  app.get(
    "/api/work",
    route((req, res) => {
      const ids = String(req.query.ids ?? "")
        .split(",")
        .filter((id) => /^[a-z0-9]{4,24}$/.test(id))
        .slice(0, 200);
      const notes = ids
        .map((id) => db.getNote(id))
        .filter((n): n is NonNullable<typeof n> => !!n && n.kind === "action" && db.isMember(n.roomId, req.user!.id));
      const keep = notes.map((n) => n.id);
      const updates = db.notesUpdates(keep);
      const shots = db.noteWorkShots(keep);
      const out: Record<string, ActionWork> = {};
      for (const n of notes) {
        const w = workOf(n, updates, shots);
        if (w.log.length || w.working) out[n.id] = w;
      }
      res.json(out);
    }),
  );
  /** A to-do's work as the log shows it. The plan only comes with a log, unless asked for. */
  function workOf(
    n: { id: string; doneAt: number | null },
    updates: ReturnType<DB["notesUpdates"]>,
    shots: ReturnType<DB["noteWorkShots"]>,
    withPlan = false,
  ): ActionWork {
    const mine = updates.filter((u) => u.noteId === n.id);
    const log = workLog(mine, shots.filter((s) => s.noteId === n.id));
    const plan = log.length || withPlan ? db.notePlan(n.id) : null;
    return { working: workingOn(mine, !!n.doneAt), ready: readyToShip(mine, !!n.doneAt), log, plan: plan && { by: plan.by, ts: plan.ts, text: plan.text } };
  }

  // One to-do or open question for its drawer: the note, where it came from, its spec and log, and
  // what it waits on and what waits on it.
  app.get(
    "/api/tasks/:id",
    route((req, res) => {
      const n = db.getNote(req.params.id);
      if (!n || (n.kind !== "action" && n.kind !== "question") || !db.isMember(n.roomId, req.user!.id)) return notFound(res);
      const m = db.getMeeting(n.meetingId);
      const links = db.roomLinks(n.roomId, "depends_on");
      const linked = (ids: string[]): TaskLink[] =>
        ids.flatMap((id) => {
          const x = db.getNote(id);
          return x ? [{ id: x.id, text: x.text, owner: x.owner ?? null, state: stateOf(x) }] : [];
        });
      const { roomId, meetingStartedAt: _s, meetingEndedAt: _e, ...note } = db.withProjects(n.roomId, [n])[0];
      const detail: TaskDetail = {
        note,
        roomId,
        meeting: m && !m.added ? { id: m.id, startedAt: m.startedAt } : null,
        work: workOf(n, db.notesUpdates([n.id]), db.noteWorkShots([n.id]), true),
        waitsOn: linked(links.filter((l) => l.fromId === n.id).map((l) => l.toId)),
        blocking: linked(links.filter((l) => l.toId === n.id).map((l) => l.fromId)),
        people: db.roomPeople(n.roomId),
        mentionsYou: db.openMentions(req.user!.id, n.roomId).filter((u) => u.noteId === n.id).map(mentionView),
      };
      res.json(detail);
    }),
  );
  app.get("/api/rooms/:id/presentation-tasks", route((req, res) => {
    if (!db.isMember(req.params.id, req.user!.id)) return notFound(res);
    res.json([...db.roomFollowUps(req.params.id), ...db.spaceNotes(req.params.id, "question", 100)]);
  }));

  app.post("/api/tasks/:id/presentation-brief", route(async (req, res) => {
    const task = db.getNote(req.params.id);
    if (!task || !["action", "question"].includes(task.kind) || !db.isMember(task.roomId, req.user!.id)) return notFound(res);
    if (!db.notePlan(task.id)) return res.status(422).json({ error: "Attach a spec to this task to get a discussion brief." });
    let brief = await planBriefs.ensure(task);
    if (brief?.status === "failed" && req.body?.retry) brief = await planBriefs.ensure(task, true);
    res.json(brief);
  }));

  app.post(
    "/api/tasks/:id/comments",
    route((req, res) => {
      const user = req.user!;
      const n = db.getNote(req.params.id);
      if (!n || (n.kind !== "action" && n.kind !== "question") || !db.isMember(n.roomId, user.id)) return notFound(res);
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text || text.length > TASK_COMMENT_MAX) {
        return res.status(400).json({ error: `Write a comment of 1 to ${TASK_COMMENT_MAX} characters.` });
      }
      const comment = db.addUpdate({
        roomId: n.roomId,
        itemId: n.itemId,
        noteId: n.id,
        noteText: n.text,
        userId: user.id,
        userName: user.name,
        client: null,
        status: "comment",
        text,
        links: [],
      });
      recordMentions(db, comment, user.id);
      res.status(201).json(workLog([comment], [])[0]);
    }),
  );

  // "Dismiss": the comments on this task that tag you stop waiting on you.
  app.post(
    "/api/tasks/:id/mentions/clear",
    route((req, res) => {
      const n = db.getNote(req.params.id);
      if (!n || !db.isMember(n.roomId, req.user!.id)) return notFound(res);
      db.clearMentions(n.id, req.user!.id);
      res.json({ ok: true });
    }),
  );

  app.get("/api/tasks/:id/plan-review", route((req, res) => {
    const task = db.getNote(req.params.id);
    if (!task || task.kind !== "action" || !db.isMember(task.roomId, req.user!.id)) return notFound(res);
    const version = typeof req.query.version === "string" ? req.query.version : undefined;
    const review = reviewFor(db, task.id, version);
    if (!review) return notFound(res);
    res.json(review);
  }));
  app.post("/api/tasks/:id/plan-review", route((req, res) => {
    const task = db.getNote(req.params.id);
    if (!task || task.kind !== "action" || !db.isMember(task.roomId, req.user!.id)) return notFound(res);
    const thread = changeReview(db, task.id, req.user!.name, req.body ?? {});
    if (!thread) return res.status(400).json({ error: "Select a passage or enter a valid comment." });
    logThreadChange(db, task, thread, req.body?.action, { userId: req.user!.id, userName: req.user!.name, client: null });
    // A comment made while the plan's design review runs is a point: it gets a slide.
    if (req.body?.action === "create") specTouched(task);
    res.json(thread);
  }));
  // Check an action item off ({ done: true }) or reopen it.
  app.patch(
    "/api/rooms/:id/followups/:noteId",
    route((req, res) => {
      const note = db.setActionDone(req.params.id, req.params.noteId, req.body?.done ? req.user!.name : null);
      if (!note) return notFound(res);
      sessions.get(req.params.id)?.followUpsChanged();
      doneDecks.schedule(req.params.id);
      res.json(note);
    }),
  );

  // Someone confirms a later decision replaced this one, or says both stand: { by, replaced }.
  app.post(
    "/api/rooms/:id/decisions/:noteId/replaced",
    route((req, res) => {
      if (!db.isMember(req.params.id, req.user!.id)) return notFound(res);
      try {
        res.json(
          agents.confirmReplaced(
            { user: req.user!, token: null },
            { ref: `stand:decision/${req.params.noteId}`, by: `stand:decision/${String(req.body?.by ?? "")}`, replaced: req.body?.replaced !== false },
          ),
        );
      } catch (err) {
        if (err instanceof AgentError) return void res.status(400).json({ error: err.message });
        throw err;
      }
    }),
  );

  // Move a to-do or open question (the space page's Tasks tab): { state: "done" | "dropped" | "open", reason? },
  // or { saidDone: false } to take off a Said done mark Stand heard wrong.
  app.patch(
    "/api/rooms/:id/tasks/:noteId",
    route((req, res) => {
      if (!db.isMember(req.params.id, req.user!.id)) return notFound(res);
      const state = String(req.body?.state ?? "");
      const note =
        req.body?.saidDone === false
          ? db.setSaidDone(req.params.id, req.params.noteId, null)
          : ["done", "dropped", "open"].includes(state)
            ? db.setTaskState(req.params.id, req.params.noteId, {
                state: state as "done" | "dropped" | "open",
                by: req.user!.name,
                reason: state === "dropped" ? String(req.body?.reason ?? "").trim().slice(0, 200) || null : null,
              })
            : null;
      if (!note) return notFound(res);
      sessions.get(req.params.id)?.followUpsChanged();
      doneDecks.schedule(req.params.id);
      res.json(note);
    }),
  );
}

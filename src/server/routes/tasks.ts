// To-dos and open questions: their drawer, comments, work logs, plan reviews and state.
import type { Express } from "express";
import { type ActionWork, type QuestionClosed, TASK_COMMENT_MAX, type TaskDetail, type TaskLink } from "../../shared/protocol.ts";
import { stateOf } from "../../shared/tasks.ts";
import { AgentError } from "../agents.ts";
import type { DB } from "../db.ts";
import { mentionView, recordMentions } from "../mentions.ts";
import { changeReview, logThreadChange, reviewFor } from "../planReview.ts";
import { sweepQuestions } from "../questionSweep.ts";
import { answerOf } from "../spaceSettle.ts";
import { readyToShip, workingOn, workLog } from "../workLog.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

export function taskRoutes(app: Express, ctx: Services) {
  const { db, agent, planBriefs, sessions, doneDecks, agents, specTouched } = ctx;
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
      const parts = n.kind === "action" ? db.noteParts(n.id) : [];
      // One level: a to-do with parts has no parent, and a parent is a to-do that is no part itself.
      const choices = parts.length
        ? []
        : db.openActions(n.roomId).filter((x) => x.id !== n.id && (!x.parentId || !db.getNote(x.parentId))).reverse();
      const answered = n.kind === "question" && stateOf(n) === "done" ? answerOf(db, n) : null;
      const detail: TaskDetail = {
        note,
        roomId,
        meeting: m && !m.added ? { id: m.id, startedAt: m.startedAt, ...(m.chat ? { chat: true } : {}) } : null,
        work: workOf(n, db.notesUpdates([n.id]), db.noteWorkShots([n.id]), true),
        waitsOn: linked(links.filter((l) => l.fromId === n.id).map((l) => l.toId)),
        blocking: linked(links.filter((l) => l.toId === n.id).map((l) => l.fromId)),
        parent: (n.parentId && linked([n.parentId])[0]) || null,
        parts: linked(parts.map((x) => x.id)),
        parentChoices: choices.map((x) => ({ id: x.id, text: x.text, owner: x.owner ?? null, state: stateOf(x) })),
        people: db.roomPeople(n.roomId),
        mentionsYou: db.openMentions(req.user!.id, n.roomId).filter((u) => u.noteId === n.id).map(mentionView),
        answer: answered && { id: answered.id, text: answered.text },
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

  // Give a to-do to someone: { owner: "Name" }, or { owner: null } to leave it unassigned.
  app.patch("/api/rooms/:id/tasks/:noteId/owner", route((req, res) => {
    if (!db.isMember(req.params.id, req.user!.id)) return notFound(res);
    const before = db.getNote(req.params.noteId);
    if (!before || before.kind !== "action" || before.roomId !== req.params.id) return notFound(res);
    const owner = req.body?.owner;
    if (owner !== null && (typeof owner !== "string" || owner.trim().length > 80))
      return void res.status(400).json({ error: "Use a name of 80 characters or fewer, or null to leave it unassigned." });
    const next = owner === null ? null : owner.replace(/\s+/g, " ").trim() || null;
    if (next !== before.owner) {
      try {
        agents.updateAction({ user: req.user!, token: null }, { ref: `stand:action/${before.id}`, owner: next ?? "unassigned" });
      } catch (err) {
        if (err instanceof AgentError) return void res.status(400).json({ error: err.message });
        throw err;
      }
    }
    res.json(db.getNote(before.id));
  }));

  // Close open questions, one or a swept list at once: { rows: [{ id, answer } | { id, decisionId } | { id, drop }] }.
  // An answer is kept as a decision the question points to. A row that can't close (already closed,
  // gone) is left out of the reply.
  app.post(
    "/api/rooms/:id/questions/close",
    route((req, res) => {
      const roomId = req.params.id;
      if (!db.isMember(roomId, req.user!.id)) return notFound(res);
      const rows: unknown[] = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 200) : [];
      const caller = { user: req.user!, token: null };
      const closed: QuestionClosed[] = [];
      let refused: string | null = null;
      for (const raw of rows) {
        const row = (raw ?? {}) as { id?: unknown; answer?: unknown; decisionId?: unknown; drop?: unknown };
        const q = typeof row.id === "string" ? db.getNote(row.id) : null;
        if (!q || q.kind !== "question" || q.roomId !== roomId) continue;
        try {
          const out = agents.closeQuestion(caller, {
            ref: `stand:question/${q.id}`,
            answer: typeof row.answer === "string" ? row.answer : undefined,
            decision: typeof row.decisionId === "string" ? `stand:decision/${row.decisionId}` : undefined,
            drop: typeof row.drop === "string" ? row.drop : undefined,
          });
          const by = out.answered_by;
          closed.push({ note: db.getNote(q.id)!, decision: by && { id: by.ref.split("/")[1], text: by.text, made: !!by.new } });
        } catch (err) {
          if (!(err instanceof AgentError)) throw err;
          refused = err.message;
        }
      }
      if (!closed.length && refused) return void res.status(400).json({ error: refused });
      if (closed.length) doneDecks.schedule(roomId);
      res.json({ closed });
    }),
  );

  // Stand's proposals for the space's open questions (questionSweep.ts): which a decision answers
  // and which nobody needs answered any more. It changes nothing; the close above does.
  app.post(
    "/api/rooms/:id/questions/sweep",
    route(async (req, res) => {
      if (!db.isMember(req.params.id, req.user!.id)) return notFound(res);
      const proposals = await sweepQuestions(db, agent, req.params.id);
      if (!proposals) return void res.status(422).json({ error: "Stand couldn't read the questions just now. Try again in a moment." });
      res.json({ proposals });
    }),
  );

  // Move a to-do or open question (the space page's Tasks tab): { state: "done" | "dropped" | "open", reason? },
  // or { saidDone: false } to take off a Said done mark Stand heard wrong. A question opened again
  // lets go of its answer; { undoAnswer: decisionId } also takes back the decision that answer made.
  app.patch(
    "/api/rooms/:id/tasks/:noteId",
    route((req, res) => {
      if (!db.isMember(req.params.id, req.user!.id)) return notFound(res);
      const state = String(req.body?.state ?? "");
      const before = db.getNote(req.params.noteId);
      if (state === "open" && before?.kind === "question" && before.roomId === req.params.id) {
        const undo = typeof req.body?.undoAnswer === "string" ? req.body.undoAnswer : undefined;
        const reopened = agents.reopenQuestion({ user: req.user!, token: null }, { ref: `stand:question/${before.id}`, undo });
        if (!reopened) return notFound(res);
        doneDecks.schedule(req.params.id);
        return void res.json(reopened);
      }
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

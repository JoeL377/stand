# Open questions: answer, drop, sweep

An open question is a task with the verb Answer (`notes.kind = 'question'`). It closes in one of three ways: with an **answer**, which Stand keeps as a decision the question points to (`links.relation = 'leaves'`, `closed_by = 'answered'`); on a **decision the space already has**; or **dropped**, with why. The settle pass (`spaceSettle.ts`) still closes one on its own when a later decision answers it.

## Reach it

- Space page → Tasks → **Answer** after an open question's text. It opens a box under the line; Enter saves. The toast's Undo opens the question again and takes back the decision the answer made.
- The task drawer of a question: an **Answer** section with the same box, or the answer once it has one.
- Tasks → **✦ Sweep questions** (shown from 5 open questions, with no project filter and Mine off). Stand lists the questions it thinks a decision answers or nobody needs any more, each ticked. **Close N questions** closes the ticked ones in one step. Nothing closes before that.
- A closed question is under Done (pill **Answered**, the answer on hover) or Dropped (the reason on hover). The answer is on the Decisions tab with an **Answer** pill that shows its question.
- API: `POST /api/rooms/:id/questions/close` with `{ rows: [{ id, answer } | { id, decisionId } | { id, drop }] }`, `POST /api/rooms/:id/questions/sweep` for the proposals, and `PATCH /api/rooms/:id/tasks/:noteId` with `{ state: "open", undoAnswer? }` to open one again.
- MCP: `list_questions` (open ones, oldest first), `close_question` with one of `answer`, `decision` or `drop`. `get` on a question gives `status` (open, answered, dropped), `answered_by` and `why_dropped`; on a decision, `answers`.

## Drive it

Nothing in the app adds an open question by hand, and the heuristic notes of the scripted demo don't leave enough of them. So this journey runs on the preview's sample data, not on `launch.sh`'s empty instance:

```bash
RUN="${TMPDIR:-/tmp}/stand-verify/questions" && mkdir -p "$RUN"
export DATA_DIR="$RUN/preview" PORT=3913 PREVIEW_USER=sam@acme.test
node --import tsx scripts/seed-preview.ts
env -u ANTHROPIC_API_KEY node --import tsx src/server/index.ts >"$RUN/server.log" 2>&1 & echo $! >"$RUN/server.pid"
npx vite --port 5183 --strictPort >"$RUN/vite.log" 2>&1 & echo $! >"$RUN/vite.pid"
echo 5183 >"$RUN/port"
NODE_PATH="$(npm root -g)" node .claude/skills/verify-stand/scripts/questions.cjs "$RUN"
kill "$(cat "$RUN/server.pid")" "$(cat "$RUN/vite.pid")"
```

It sweeps (unticks one, closes two), answers one under its line, checks Done and the Decisions tab, undoes an answer, answers one from the drawer, then lists and drops one over the MCP. Each change is read back from `/api/rooms/<id>/feed`. About 20 seconds. Seed again before a second run: the journey closes the sample questions.

## Gotchas

- **The sweep's model pass is not driven.** Without a key the page says "Stand couldn't read the questions just now", and the script checks that. It then answers the sweep request itself with proposals built from the space's own questions and decisions; the close that follows is real. `questionSweep.test.ts` covers the pass with a scripted model. What a real model proposes on a real space is unverified here.
- A toast stays while the pointer is on it, so two "Answered" toasts can be up at once. The script dismisses them between steps.
- In dev, React runs the sweep request twice; the server makes one read of it (`questionSweep.ts`).
- Ticking a question's checkbox still closes it with no answer ("Closed without an answer").

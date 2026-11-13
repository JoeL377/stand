# A to-do's parts on the Tasks tab

A to-do can be a part of another to-do (`notes.parent_id`, one level). The Tasks tab shows the relation on the list (`withParts` and `partsTally` in `src/shared/tasks.ts`, `byOwner` in `src/web/pages/SpaceHome.tsx`).

## Reach it

- Space page → Tasks → a project's row. In the project's view a part sits under its parent, one step in (`li.part`), when both are in that project. It stays there whoever owns it: the family is in the parent's owner group.
- The parent's row has a pill, `1/3 parts`: done parts of the ones still wanted. A dropped part doesn't count. It counts every part, also the ones a filter or `Mine` keeps out of view.
- A part whose parent isn't the row above it names it after its text, `Part of: …`, and a click on that opens the parent. That is a part under **For you**, under **Done** or **Dropped**, in another project than its parent, or with `Mine` on while the parent is someone else's.
- The task drawer sets it: `Make it a part of a to-do` / `Change` → `Remove` under **Part of**. Agents set it with `parent` on `create_action` and `update_action`.

## Drive it

No journey on `launch.sh`'s empty instance leaves parts in each of those places, so this one runs on the preview's sample data, like the questions journey:

```bash
RUN="${TMPDIR:-/tmp}/stand-verify/task-parts" && mkdir -p "$RUN"
export DATA_DIR="$RUN/preview" PORT=3914 PREVIEW_USER=sam@acme.test
node --import tsx scripts/seed-preview.ts
env -u ANTHROPIC_API_KEY node --import tsx src/server/index.ts >"$RUN/server.log" 2>&1 & echo $! >"$RUN/server.pid"
npx vite --port 5184 --strictPort >"$RUN/vite.log" 2>&1 & echo $! >"$RUN/vite.pid"
echo 5184 >"$RUN/port"
NODE_PATH="$(npm root -g)" node .claude/skills/verify-stand/scripts/task-parts.cjs "$RUN"
kill "$(cat "$RUN/server.pid")" "$(cat "$RUN/vite.pid")"
```

It checks the sample families (a parent with a done part and two open ones, one of them someone else's; a parent with a part under For you), opens a parent from `Part of: …`, makes a to-do a part in the drawer, ticks it off, reads the parents back from `/api/rooms/<id>`, then looks at `Mine` and at a phone's width. About 15 seconds. Seed again before a second run: the journey changes the sample to-dos.

## Gotchas

- Wait for `.sh-task-group.for-you` before reading rows. A to-do that is ready to ship moves from its section to For you once its work has loaded, so a part can be under its parent for a moment first.
- The sample data has two to-dos named "Remove the browser retry path": Priya's is the part, Leo's came from the chat.
- A part goes under its parent only inside one section. Give a part its own project by hand and it moves to that section as a row of its own, with `Part of: …`.
- Not driven: a parent that was deleted (the part reads as having none), and more than one level, which the server refuses. `src/web/taskParts.test.ts` covers what the list does with such data.

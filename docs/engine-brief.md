# Engine brief: what's true now

Nov 4, 2026 · Huy Ngo · for the session that owns this work

Build the part of Stand that knows what the team currently believes. Ask "what's true now?" and get only what's still standing, each line with its why and what it replaced. When something new goes against that, say so, without stopping anyone.

This is the core of the old Conxt engine, rebuilt natively in Stand. Read [the plan](mvp-plan.md) and [the primitives](mvp-primitives.md) first. Then call `whats_new`, because things may have moved since this was written: Huy was about to meet Janesh, and Joe hasn't weighed in on rebuilding in Stand.

## Why it matters

Stand's Decided card has 40 lines, and they contradict each other. Agents and people read them all and work out by hand what still holds. The direction changed about five times in three weeks with nothing marking it, which is a large part of why the team stalled. An agent in this repo gave wrong advice for days for the same reason.

There are two halves:

- **Tracking** is small and mechanical: what was decided, by whom, why, and what replaced what.
- **Understanding** is the hard part: noticing that two lines disagree when nobody said so. This is what makes the product more than a to-do app, so it gets tested first.

## What exists

| Piece | Where | State |
| --- | --- | --- |
| Context kind, `add_context`, `list_context` | `src/server/agents.ts`, `mcp.ts` | Shipped in #63 |
| `links` table: `leaves`, `replaces`, `serves`, `conflicts`, `objects` | `src/server/db.ts` | Only `replaces` is written so far |
| `whats_new` | `src/server/agents.ts` | Shipped in #65 |
| Heard decisions and Confirm | `src/server/liveList.ts` | Shipped in #56 |
| The why | `whyOf` in `src/server/agents.ts`, from `discussions.positions_json` and `notes.quote_json` | On decisions in `get` and `whats_new`. Not on the Decided card yet |
| Reversal finding | `src/server/spaceSettle.ts` | Weak. One call over everything, told to be conservative. Its findings are now proposals: a decision stays kept until someone confirms |

## What to take from Conxt

Conxt is in `nxt-lvl/conxt-v7`. Use it as a reference and don't port the code. It's frozen.

| Take the idea from | What it shows |
| --- | --- |
| `src/conxt/core/collation.py`, `_classify_relationships` | The simplest shape: one new item against candidates, each labeled, kept only at confidence 0.7 or higher |
| `src/conxt/core/judge.py`, `get_neighborhood`, `_build_judge_prompt` | Choosing what to compare against, and how the prompt is framed |
| `src/conxt/core/conflicts.py` | Grouping related claims into one thing to settle, so people see one card and not five |
| `docs/evidence-seeking-judge.md` | Duplicate, Supersede, Merge and Conflict are separate from whether a claim is admitted |
| `src/conxt/core/live_callouts.py`, on branch `feat/live-callouts` (#117) | Checking returned ids, caching per stream revision, failing without breaking the meeting |
| `scripts/eval_meeting_decisions.py` | Scoring against a human key, and caching every call by its exact request so reruns are free |
| `docs/admission-evaluation.md` | Once you've tuned on a set, it stops being held-out evidence |

**Leave behind:** holds, approval gates, trust scoring, governance policies, the review ceremony, and the local daemon. They're the bottlenecks Huy chose to drop. Nothing here blocks a person or an agent.

**One known mistake to avoid.** `live_callouts.py` only compares lines that share two or more words. That filter would miss the biggest reversal below, which shares almost no words, and the transcript's "Connect" is the same thing as "Conxt". A space has a few hundred decisions at most, so start by comparing a new line against all of them in one call, and filter only if cost forces it.

## The test set

These are from the Conxt 1.0 space. Labels are a first pass by hand, so have Huy check them, and pull the exact lines through the MCP.

**Reversals. It must find these:**

| Earlier | Later |
| --- | --- |
| "Port Connect one to one" (Oct 17) | "Build what Stand needs into Stand rather than using Conxt" (Oct 30) |
| "Everything, including decisions, asks and choices, is a task" (Oct 20) | "Keep decided as a knowledge base" (Oct 28) |

**Duplicates. It should merge these, not call them conflicts:**

| One | Other |
| --- | --- |
| "Review is a mechanism or process, not a primitive" (Oct 20) | "Review is a mechanism, not an object" (Oct 21) |
| "A task is one primitive, with states such as to do, in progress and complete" (Oct 20) | "Task is the core primitive of the Connect work group" (Oct 21) |
| "Port Connect one to one" (Oct 17) | "Build for multiplayer, not around the meeting channel; start with a one-to-one port" (Oct 17) |

**Traps. It must leave these alone:**

| One | Other | Why |
| --- | --- | --- |
| "Do not integrate Connect via MCP and APIs; work in one codebase" (Oct 17) | "Build what Stand needs into Stand rather than using Conxt" (Oct 30) | Both say one codebase |
| "Topic moves on only when a user explicitly moves it on" (Oct 25) | "Shared board is controlled by host's view" (Oct 25) | Same area, no disagreement |
| "No auto-inferred decisions; user confirms by click" (Oct 28) | "Ask the agent by push-to-talk" (Oct 28) | Same meeting, unrelated |

**Not durable. These shouldn't be kept as decisions:** the Wizards jersey, "Meet Saturday morning at 9am", "End the meeting and restart it", "Discuss the item without Andy", "Try the async route".

A false alarm costs more than a miss: if people learn to ignore the flag, the feature is dead.

## Order of work

Each step is a small PR.

1. **Live check.** Merging redeploys Stand, which can cut a call, and an agent can't see whether a meeting is live. Add `live` to `list_spaces`.
2. **The eval, before any product code.** A script that runs a check over the 40 decisions and scores it against the set above. Compare `spaceSettle`'s approach with one line against all. Keep meeting data and answers out of git. If it can't find the two reversals, stop and tell Huy.
3. **State on decisions.** Heard, kept, replaced. `spaceSettle`'s findings become proposals anyone can confirm, not silent changes.
4. **The why.** Derive it from the discussion's positions and the quote; no new capture needed.
5. **`search` on the MCP.** SQLite FTS5 works on Node 22. It returns standing lines with their why and what they replaced, and is what agents call to ask what's true.
6. **Conflict check when something is kept.** It opens a decide task for the owner and writes a `conflicts` link. Work carries on.
7. **Live callouts**, last. They reuse step 6 during a call.

## Where the check stands

Nov 5. People's own agents can run it over the MCP: `next_check` hands out the newest unchecked decision, `submit_check` takes the findings back, and Stand pays for no model call. Findings at 0.7 or higher show as proposals. Lower ones stay on record. Nothing tells agents to run it yet.

Blind runs by an agent, one each, so treat them as signals:

| Run | Reversals found at 0.7 | Traps tripped |
| --- | --- | --- |
| The brief's set, decisions alone | 0 of 2 | 0 of 3 |
| The brief's set, with each discussion | 0 of 2 | 0 of 3 |
| Held-out set, key written first, with each discussion | 3 of 4 | 0 of 7 |

It's reliable on plain reversals and weak on subtle ones. The Oct 17 to Oct 30 port reversal scored 0.40 in one run and 0.35 in the next, so a lower cutoff wouldn't catch it reliably. All of this ran on Claude only.

## Rules

- **Merge your own PRs when CI is green.** Huy approved that on Nov 4. Check that no meeting is live first. Auto-merge isn't available on this repo.
- **Nothing blocks.** Objections are signals. Stand never decides on its own, and any one person's click keeps a decision.
- **Paid model calls:** ask Huy before each paid run, say the expected cost, and don't run paid jobs in parallel. Never send meeting data to free or logging models. Stand's own Anthropic key is on Railway, so a local eval needs a key from Huy, and Huy enters it. Never handle keys or tokens yourself.
- **Others are in this code.** Janesh is working toward using Stand daily "as the orchestrator", with nothing pushed yet, and it may touch `agents.ts` and `mcp.ts`. Joe owns the board and the meeting. Check open PRs and branches before starting a piece.
- **Verify what you claim.** Count from real data. Don't infer from one empty field.

## Working with Huy

Huy wants plain words, a recommendation and not a survey, and to keep moving without being asked at every step. Ask only when blocked or before paying for something. Generated UI copy uses colons and periods, never em dashes, and reuses existing components. Use they/them for anyone whose pronouns you don't know.

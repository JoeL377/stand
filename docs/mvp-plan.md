# MVP plan: from building to a feedback loop

Draft 3, Nov 4, 2026 · Huy Ngo · direction set; comments welcome, and the build doesn't wait on them

The loop we want already works, for one person. Joe's agent reads Stand's to-dos, does them and closes them, and the next meeting opens on what shipped. The plan is to get the other three of us into that loop this week, make what it keeps worth trusting, put Janesh's cofounders on it by Nov 23, and a team that shares a repo by Nov 30.

All numbers come from the Conxt 1.0 space and both repos as of Nov 4. Meeting dates are Pacific; Stand shows some of them a day later, in UTC.

## Why progress stalled

Hosting got the blame, but three other things did the damage.

**1. Only Joe is in the loop.**

| Oct 11 to 31 | Joe | Huy | Janesh | Andy |
| --- | --- | --- | --- | --- |
| To-dos closed, by who closed them (60 in all) | 58 | 0 | 2 | 0 |
| ...of those, closed by their agent | 38 | 0 | 0 | 0 |
| Agent updates posted to Stand (53 in all) | 53 | 0 | 0 | 0 |
| To-dos still open, by owner | 15 | 18 | 7 | 10 |
| PRs merged in Stand (58 in all) | 51 | 6 | 0 | 1 |

Where the loop runs it runs well: the median to-do closed in 2 days. But Huy has no agent connected to Stand, and 63 Conxt PRs since September closed nothing on the board. 31 of the 55 open to-dos are over two weeks old.

**2. The direction keeps changing, and nothing records that it changed.**

| When | What we decided |
| --- | --- |
| Oct 12 | One product named Conxt. Stand's meeting experience leads, synthesis lives in the engine |
| Oct 17, in a meeting | One codebase, no integrating over MCP and APIs. Port Stand into Conxt's repo one to one by Monday |
| Oct 17, in Conxt | Conxt is the engine; Stand's meetings are one connector through a contract |
| Oct 20 | Everything is a task. One primitive |
| Oct 28 | Build a memory layer on Stand's current model; revert if it doesn't work |
| Oct 30 | Build in Stand rather than use Conxt. Rebuild, don't port. "Everything is definitely not a task." Primitives open again |

Stand's Decided card still shows all of these as live, with nothing marked replaced. The two Oct 17 lines disagreed on the same day, and connector work (Conxt #104 to #117) carried on for two weeks after the meeting had said no. Who has the last word has been an open question on the board since Oct 20.

**3. Nobody outside is waiting on us.** Design partners have been the named constraint since June. About 140 PRs have merged across both repos since September, and none of them had a user outside the four of us. With no outside deadline, a quiet week costs nothing. The last real meeting was Oct 30, after 13 meetings and 13.5 hours of talk in three weeks.

Building isn't the bottleneck. Joe merged 16 PRs from Oct 25 to 28, and the sprint before that did about 40 in four days. So this plan spends its effort on decisions and users, and assumes code is fast.

## What the MVP has to prove

The Oct 8 multiplayer plan said it best, and it's still unproven:

> One person's accepted learning helps another person's agent do the right work, and discoveries during that work improve the team's shared understanding.

The test, run on real work:

1. In a call, two of us decide something and say why. One click keeps it.
2. Whoever was away hears about it and can object.
3. The next morning, someone else's agent starts a task and hears that decision without being told.
4. Its work runs into something that contradicts the decision. It says so and keeps going, and that comes back as something to decide.
5. The PR merges and the task closes, with the PR as its evidence.
6. The next conversation opens on what shipped and what needs deciding.

**MVP is done when that runs without us steering it, for four weeks, on a team that shares a repo and has nobody from our team in it.** That's the group we're building for, and only they can run the whole test.

Brista comes first, and proves less. Brista is Janesh's coffee water company: the cofounders chat on Discord and talk in person, with no calls. They test the chat half: talk becomes tasks and decisions with zero lift, and people come back to them. They can't test steps 3 to 5 if they don't work through agents on a repo, and Janesh is on both teams, so it isn't a test without us.

## How we work

Speed comes first, for us and for the small teams we build for. Each rule below can change later, so none of them needs a long debate now.

- **Rebuild in Stand, for now.** Huy's call, Nov 4.
- **The owner of an area decides and ships.** Huy on knowledge, Joe on the meeting and board, Janesh on architecture and primitives, Andy on infrastructure and outside teams.
- **An objection is a signal, not a block.** Anyone can object. It shows on the decision and the owner sees it, but nothing stops.
- **Anything can be reversed.** A change of direction names the line it replaces and why.
- **Merge when CI is green.** Nobody waits on a review.

The product follows the same rules. A decision takes effect when someone keeps it, and nothing a person or agent is doing waits on anyone else. People who were away get told, not asked. A conflict is raised for the owner while the work carries on. Stand still never decides on its own: a person's click keeps a decision, and any one person's click is enough.

This moves away from Conxt's governance model, which holds things until the right people approve. For small teams, a block costs more than a mistake that's easy to reverse. Holds can come back when a larger team asks for them.

## Who's on what

This will be messy while we work out how to work together, so the aim is to keep each other's work in view, not to plan the mess away. Oct 20 named the real bottleneck: not knowing who's on what.

| Who | On | Where it shows |
| --- | --- | --- |
| Janesh | Extending Stand to use daily, for everything, "as the orchestrator". Also how the Discord bot fits | Nothing pushed yet. Janesh joined the repo Oct 27 |
| Joe | The board and meeting. #60 is open, and a live eval branch has no PR yet | Stand PRs |
| Huy | Context, decisions and links in Stand | This plan |
| Andy | Trying other use cases; moving the repo | Nothing yet |

Three habits keep this cheap:

- **Say it before you start.** Your agent marks the to-do as working in Stand, so the board shows who's on what. If there's no to-do, add one.
- **Push early.** Work on a laptop is invisible, so push a branch or open a draft PR on day one.
- **Keep PRs small.** Everyone is in the same few files, so small PRs and frequent rebases beat coordinating.

**Janesh's goal and this plan.** They fit. A team that uses Stand daily for everything is Gate 1, and being the place work starts and comes back to is the Use step. What's unsettled is what "orchestrator" means. Stand could hand work to the agents people already run, or Stand could run the agents. Oct 25 leaned thin: your own agent, with an optional reference agent. Oct 28 said Stand "actually becomes the orchestrator", a multiplayer projects page, while people keep their own Claude or Codex. The first keeps Stand thin and needs little new; the second is much more to build and puts us in the middleman box Janesh warned about on Oct 25. Janesh owns this call.

## The flywheel

1. **Talk.** A meeting or chat channel produces decisions, tasks and context.
2. **Keep.** Each is stored with who, why and the quote.
3. **Use.** Agents read it at the start of work and work from what the team decided.
4. **Close.** Evidence closes tasks; conflicts come back to a person.
5. **Open better.** The next conversation starts from what changed, so it's shorter and worth having.

Each turn should leave the team starting smarter than the last one. That's the question from the Karpathy loop that nobody measures, and here it's one number: how often a kept decision changed what a person or agent did.

| Step | Works today | Missing |
| --- | --- | --- |
| Talk | Meetings, running list, Ask Stand | A chat channel |
| Keep | To-dos, decisions and questions with owner and quote | Context; the why; about a quarter of Decided isn't durable (a jersey, "meet Saturday at 9"); owners are loose strings, so "Duke" gets credit Huy doesn't |
| Use | MCP tools for to-dos and briefs; Copy for agent | Search over what's kept; hearing it at session start; agents writing back |
| Close | A linked PR closes its to-do; Confirm on heard decisions | 0 of 115 tasks have a done-when; 28 of 60 closes carry no evidence; explorations don't end in a next step (Janesh, Oct 30) |
| Open better | Kickoff card, suggested agenda | What's stuck and what conflicts |
| Conflicts | `spaceSettle` looks for reversals after a meeting | It decides on its own, which breaks "Stand never decides", and has flagged 0 of 40, missing the reversals above |

Our own Decided list is the first test set: the conflict check has to find those reversals.

## Timeline

Every week ends with a demo in the weekly meeting. Sizes are rough: S is under a day with an agent, M is two or three days.

### Week 0, Nov 4 to 8: Restart

Mostly setup, and none of it holds up the build: week 1 can start now. Demo: the board shrinks, and Huy's agent closes a to-do.

| Work | Owner | Size |
| --- | --- | --- |
| Connect each person's agent on Stand's Connect an agent page; each closes one real to-do | Huy, Janesh, Andy | 10 min each |
| Triage the board: confirm the 22 matches in [the match list](stand-todo-matches.md), close or drop the 6 open Railway to-dos | All | S |
| Share [the primitives](mvp-primitives.md). Janesh said "I'm good with that" on Oct 30, so building starts on them now | Huy | S |
| Fix one weekly meeting | All | S |
| Add CI to Stand. Done in #61: typecheck and tests run on every PR, and both pass on main | Huy | Done |
| Turn on the Stand GitHub App in production (it reports as off) | Joe | S |
| Move the repo off Joe's personal account. nxt-lvl's Actions billing is failing, so fix that first or pick another org | Joe, Andy | S |
| Freeze Conxt: keep it running locally, stop Stand's retries to the dead hosted address, keep #115 and #117 as reference | Huy | S |

### Week 1, Nov 9 to 15: Keep

Demo: the Decided card reads as what we actually believe, each line with a why.

| Work | Owner | Size |
| --- | --- | --- |
| Context as a kept kind, with the links in the primitives doc | Huy | M |
| The why, and who proposed, agreed and was away, on every decision | Huy | M |
| Clean Decided: durable choices stay, the rest become tasks or go | Huy | S |
| A reversal Stand spots is flagged for anyone to confirm, not applied on its own. Nothing waits on it | Huy | M |
| Owners are people, with nicknames as aliases | Joe | S |
| Every options card and Ask Stand answer ends as a task with an owner, a decision, or dropped | Joe | M |
| Ask for a done-when when a task has none | Joe | S |

**Gate 1, Nov 15:** all four of us closed work through an agent this week. If not, that's the first item at the next meeting. Building carries on.

### Week 2, Nov 16 to 22: Use

Demo: Janesh's agent hears the Oct 30 decision without being told, and a Discord message becomes a Stand to-do.

| Work | Owner | Size |
| --- | --- | --- |
| Stand as the daily home: start from your tasks, send one to your agent, and see it come back. Oct 20 asked for "send to your agent, not copy-paste", and Joe's Oct 28 idea is an agent that pulls your tasks every 30 minutes | Janesh | M |
| `search` on the MCP, over decisions and context (SQLite FTS5 works here) | Huy | M |
| `remember` on the MCP: an agent proposes, a person confirms | Huy | S |
| Session start plugin for Claude Code and Codex: your tasks, decisions near this repo, what waits on you. Conxt's hook is the reference | Huy | M |
| One intake path for any channel: text in, tasks and decisions with quotes out | Huy, Janesh | M |
| Discord: the bot feeds a Stand space and answers with what's open | Janesh | M |

### Week 3, Nov 23 to 29: Brista goes live

Thanksgiving week, so short on purpose. Demo: their real to-dos on the board.

| Work | Owner | Size |
| --- | --- | --- |
| Janesh's Brista cofounders start, with zero lift from them. No PRs there, so a task closes on the owner's click | Janesh | |
| Sign up the repo team for Nov 30 | Andy | |
| Real deletion: today a meeting or space can only be archived | Huy | S |
| Nightly backups: Stand is one SQLite volume with none in the repo | Andy | S |
| One page on what's stored, who sees it and which models read it. Railway's leak makes this a real question | Andy | S |
| A spend cap per space, and cost under $3 a meeting hour. Today it's about $5, half of that the running list | Joe | M |

**Gate 2, Nov 29:** people outside the four of us are in the product.

### Week 4, Nov 30 to Dec 6: Check, and the repo team starts

Demo: the check finds our own reversals; "done? here's the PR" on unlinked to-dos.

| Work | Owner | Size |
| --- | --- | --- |
| A team that shares a repo and runs agents starts on it | Andy | |
| Conflict check when something is kept: it opens a decide task for the owner, and the work carries on. Must catch "port one to one" against "build in Stand", and "everything is a task" against "keep Decided as a knowledge base", with few false alarms | Huy | M |
| Match merged PRs to unlinked to-dos; the owner confirms | Huy | M |
| Tell people who were away, with one click to object. This replaces the confirm step decided on Oct 16, which held decisions until they answered | Huy | S |

### Weeks 5 and 6, Dec 7 to 20: Live

| Work | Owner | Size |
| --- | --- | --- |
| Live callouts: a Keep or Change card during the call, rebuilt from Conxt #117 | Huy, Joe | M |
| Review the numbers and decide | All | Dec 20 |

**Gate 3, Dec 20:** did the repo team come back three weeks running, and did Brista's cofounders come back four, without being asked? If yes, keep going and start on launch. The full four-week bar for the repo team lands Dec 27. If they use the to-dos but not the decisions, the product is the task loop and Conxt's governance waits. If Brista stays and the repo team drops, we've found a different customer, and that's worth a real conversation. If both stop, find out why before any more features.

## The feedback loop

**Every week, one fixed meeting.** It opens on the Kickoff card, then these numbers, then what needs deciding.

| Number | Today | Dec 20 |
| --- | --- | --- |
| People closing work through an agent | 1 of 4 | 4 of 4, plus outside teams |
| Closes with evidence (PR or confirmed) | 32 of 60 | 4 in 5 |
| Open to-dos over 14 days old | 31 of 55 | None without a "still on it" |
| Tasks with a done-when | 0 of 115 | Most |
| Reversals the check catches | 0 of 2 we know of | All known |
| Times a kept decision changed what someone did | Not measured | Counted weekly |
| Weeks in a row Brista came back | 0 | 4 |
| Weeks in a row the repo team came back | 0 | 3 |
| Cost per meeting hour | About $5 | Under $3 |

**Every outside team, 20 minutes a week.** What we hear goes in as tasks during the call, in the product.

**In the product:** a useful or not-useful mark on every conflict and callout, so the check has something to learn from.

**How we run ourselves:** a change of direction names the line it replaces and why. That's the product's rule, and we should live by it first.

## Not in the MVP

- A voice agent that interjects, or a Muse-style personal agent. Oct 30 asked "are we focusing too much on this as opposed to the core?"
- Fixing the pilot concept beyond what's needed, and a board redesign
- Moving off Railway, and a staging environment. The "Prod Test With 2 Users" space is enough for testing
- Mobile and in-person capture, transcript threading, priority and tags, Linear or Jira sync
- Conxt's solo daemon, explore modes and hosted server: frozen, not deleted
- Public launch, open source and the rest of the traction plan's decisions: after Gate 3

## Risks

- **The direction flips again.** Joe left before "rebuild in Stand", so tell Joe now. Joe's view is a signal like anyone's. The plan holds until Gate 3 unless someone replaces it on the record.
- **Huy carries most of the build.** Huy has shipped 6 PRs in Stand's codebase, and weeks 1 to 4 lean on Huy. Small PRs and frequent rebases keep that from colliding with Joe's work on the board.
- **CI becomes the only check.** With no review wait and a merge that deploys, a bad merge reaches production. CI is in. Backups are the first job before outside teams.
- **Without blocks, bad decisions get through.** That's the trade. The conflict check and the useful marks are how we'd see it, and Gate 3 is when to revisit it.
- **Overlap with work nobody can see.** Janesh's rebuild work and the orchestrator goal aren't on GitHub yet, and both touch the same files as Keep and Use. The habits above are the fix.
- **Brista pulls us off course.** A coffee water company will want Shopify and wholesale help, not agents on a repo. Build for them only what the chat path needs anyway, and treat the rest as a signal about who else might want this.
- **Brista flatters us.** Janesh is a cofounder there, so they'll try harder than a stranger would. Their numbers can't carry Gate 3 alone.
- **Andy's trip.** Andy mentioned Japan starting around Nov 7. The repo move may need another owner.

## Still open

- [ ] **What does "orchestrator" mean?** Janesh's call: hand work to people's own agents, or run agents in Stand.
- [ ] **Who's the repo team?** Needed by Nov 30, so this is the most urgent item here. Each of us names three that share a repo and run agents.
- [ ] **What's it called?** Oct 12 said Conxt. It doesn't block anything until outside teams see a name.

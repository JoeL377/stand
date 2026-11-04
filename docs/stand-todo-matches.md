# Stand to-dos matched to evidence

Oct 30, 2026 · Conxt 1.0 space · 48 open to-dos (59 already done) · PRs merged Oct 10 to 30 in nxt-lvl/conxt-v7 and JoeL377/stand

Nothing here has been written to Stand. Each row is a proposal for its owner to confirm.

This list was matched by hand (an agent reading Stand's board and both repos' merged PRs), as a mock-up of what the loop should do. It is not yet a Stand or Conxt feature.

## To build it for real

Stand already closes a to-do when its linked PR merges. The missing piece is matching merged PRs to to-dos nobody linked, and asking the owner. That's week 4 of [the MVP plan](mvp-plan.md), built in Stand.

## Done, with a PR (strong)

| To-do | Owner | Evidence |
| --- | --- | --- |
| Turn the transcript dump into an MD file, create a PR and merge it, then send the direct link | Huy | conxt#116, the work-loop spec, merged Oct 22 |
| Merge the hosted branch into main, resolving conflicts | Andy | conxt#80, "Bring the unified server into main", merged Oct 15 |
| Track the glossary feed from Stand into Conxt | Huy | conxt#78 serves the glossary to Stand; stand#18 and #26 use it live |
| Integrate live meeting items into current Conxt and check how it interprets them | Huy | stand#30, Conxt on the live panel; conxt#86, close the meeting loop |
| Build the flow where decisions made while someone is away need a confirm step | Huy | conxt#77 and #84, absent members confirm; held decisions |
| Build the shared governance logic into Stand so the experience can be seen | Huy | stand#29, #30, #31, what needs people on the agenda and confirm in the meeting |
| Fix the middle panel so it shows the correct topic promptly | Joe | stand#25, #33, #35, the steadier topic card |

## Probably done (owner checks)

| To-do | Owner | Evidence |
| --- | --- | --- |
| Take the work loop spec, add today's transcript, and produce a redesign | Huy | conxt#116 took in the Oct 20 call; stand#40 built the tasks redesign on its fields |
| Make accepted suggested actions become to-dos, not decisions | Janesh | stand#56, Stand never decides on its own (Joe built it) |
| Review the to-do list and meeting recap captures to check they reach Conxt | Huy | stand#34, Conxt gets evidence for captures from long discussions |
| Add transcript synthesis to Conxt, rather than a personal MCP setup | unassigned | conxt#104 and #112, Conxt reads the app's own findings |
| Allow participants to also edit to-dos | Joe | stand#40 and #44, task edits and update_action; check that participants, not only the host, can edit |
| Build live transcript ingestion | Andy | stand#2 and conxt#74 deliver transcripts; Stand's conxtLive sends them during the call |
| Check whether the move-on topic button is host-only | Joe | No PR needed: on Oct 25 Janesh clicked it ("So everybody has it") |

## Done in a meeting, no PR

| To-do | Owner | Evidence |
| --- | --- | --- |
| Invite Janesh to a meeting | Huy | Janesh has been in every call since Oct 15 |
| Meet with Janesh to get his thoughts on the Stand and Conxt shape | Andy | Janesh's views on the shape fill the Oct 17, 21 and 29 calls |

## Drop, with a reason

| To-do | Owner | Reason |
| --- | --- | --- |
| Get Railway access from Andy so Huy can deploy and test Conxt | Huy | Oct 25: the team is leaving Railway |
| Ask Andy in chat for access to the Railway account | Huy | Same; it repeats the one above |
| Deploy hosted Conxt on Railway and whitelist Huy's and Joe's emails | Andy | Done Oct 11 (conxt#74), and the team is leaving Railway |
| Deploy Conxt and set up CI/CD | Andy | Same; where to host is an open question, not a deploy |
| Port the Stand code base into Conxt's code base and deploy by Monday | Joe | Oct 29: build on Stand's current model instead of a port |
| Synthesize the discussion in your own way and bring back your interpretation | unassigned | Huy's took the form of conxt#116; close it or give each person their own |

## Still open, no evidence (31 minus the above)

Left alone: the unfollow button, Mootit access and permissions, OpenRouter, contextual speaker assignment, Slack and Discord agent, orchestrator vs own agent, Discord bot fit, other use cases, spec docs in the app, chat attachments note, parallel to-do redesign, cloud sessions credit, version history, image support in chat, noise suppression, the whiteboard, transcript to participants, the spec file from Joe's repo, the work Huy sent to Joe, keep improving the middle panel, and Janesh's look-intos from Oct 15 to 17.

## The count

| | To-dos |
| --- | --- |
| Done with a PR | 7 |
| Probably done | 7 |
| Done in a meeting | 2 |
| Drop | 6 |
| Still open | 26 |

If owners confirm, the open list goes from 48 to 26.

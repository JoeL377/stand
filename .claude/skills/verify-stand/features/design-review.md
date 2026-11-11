# Design review

A call where the team goes through a spec and leaves with a verdict on it. A to-do's plan joins the space's next design review only on request. In the call each spec is slides: its Overview, its `##` sections on at most eight slides, and its Verdict. A question is an open comment thread on the plan (the code says point); it is a step on the slide of its section, not a slide of its own.

## Sub-features
- Request: **Request review** in the plan viewer's footer, or `request_design_review` on the MCP with questions that each quote the plan.
- Prepare: the review's page (`/s/<space>/design-review`) lists each spec as its slides. The author rewrites the summary and the lines, takes sections and questions off the call, asks questions, and accepts or dismisses Stand's suggestions. A spec of more than eight sections has short adjacent sections on one slide; the author regroups with **Combine with the slide above** and **Give it its own slide**, and **Let Stand group them** undoes that.
- The call: **Start design review** on that page, or **Present task** on a to-do with a spec (a review of that one spec). The arrows go through each slide and then each of its questions; the host or the author can also click a question to open it. Questions end **Settled** or **Still open**; the Verdict takes **Approve**, **Approve with changes** or **Not yet**. **Full spec** opens the plan at the slide's part.
- Write back: Settled resolves the thread with what was decided, Still open leaves it open; at the end the to-do's log gets the verdict in a line and the to-do waits on the to-dos the review raised.
- The record: `/s/<space>/design-review/<id>`, linked from the Tasks tab row, the recap and the plan viewer. `get_review` returns it under `design_review`.

- Diagrams: a ` ```mermaid ` block in a plan is drawn as its diagram wherever the plan shows (web/Mermaid.tsx, loaded on demand). A section's slide shows the first diagram the spec has under that heading. A block that doesn't parse stays code.

## Driving it with Playwright
`scripts/design-review.cjs <run>` is its own journey with two browser contexts. The space's creator is the host, so the spec's author is the second person: that proves the author moves between the slides of their spec without being the host. It first puts a spec of twelve sections on the review to prove the eight-slide limit and the regrouping, then takes it off. It asks for the review over `/mcp`, starts it from the review's page, flips slides as the author and as the host, adds a to-do and a decision on a question with the host's add-line box, calls the questions and the verdict, makes a comment mid-call through `POST /api/tasks/<id>/plan-review` and ends the meeting. Proof is in what it reads afterwards: the threads, the to-do's log and `waitsOn`, `get_review`, the record page, the recap's link and the plan viewer.

The journey's plan has a diagram under Steps: it waits for the drawn `svg` in the plan viewer, on the Steps slide and in Full spec, and checks that a broken block on the other plan shows as code with no error drawing.

## Gotchas
- The first diagram on a page loads mermaid's chunks, so wait for `.mermaid-diagram svg` with a longer timeout than a click needs.
- Without `ANTHROPIC_API_KEY` Stand can't write the brief: the Overview has no summary and sections have no lines unless the author writes them (the journey writes one section's lines through the API). What Stand writes with a model is covered by unit tests with a stand-in model only.
- Heuristic notes catch nothing from chat, so the journey adds the to-do and the decision by hand. A proof that talk on a slide becomes its to-dos needs the key.
- The space's creator takes the host role when they join, even if someone else started the meeting. Sign the host in first.
- A comment made by selecting text can't be driven reliably headless; the journey posts the same request the plan viewer makes.
- Dates in what Stand writes ("Design review, 11 Nov") are UTC days; the pages show the browser's local day.

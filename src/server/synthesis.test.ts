import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note, Segment } from "../shared/protocol.ts";
import { briefToMarkdown, buildBrief } from "./brief.ts";
import { openDb } from "./db.ts";
import { type Agent, HeuristicAgent, type NotesContext, type SynthesisInput } from "./llm.ts";
import { RoomSession } from "./room.ts";

const INSTRUCTIONS = "List blockers by person.\nPull out customer quotes verbatim.";

/** The Claude agent with its API calls caught instead of sent. */
async function claudeAgent() {
  const { config } = await import("./config.ts");
  const { createAgent } = await import("./llm.ts");
  const was = config.anthropicKey;
  Object.assign(config, { anthropicKey: "test-key" });
  const agent = createAgent();
  Object.assign(config, { anthropicKey: was });
  const prompts: string[] = [];
  const requests: Array<{ model: string; system: string; messages: Array<{ content: string }> }> = [];
  Object.assign(agent, {
    parse: async (_schema: unknown, content: string) => {
      prompts.push(content);
      return null;
    },
    client: {
      beta: {
        messages: {
          create: async (req: (typeof requests)[number]) => {
            requests.push(req);
            return { stop_reason: "end_turn", content: [{ type: "text", text: "**Blockers**\n- Huy: waiting on the staging keys" }] };
          },
        },
      },
    },
  });
  return { agent, prompts, requests };
}

const seg = (text: string, speakerName = "Huy", itemId: string | null = null): Segment => ({
  id: text,
  meetingId: "m1",
  itemId,
  speakerId: speakerName,
  speakerName,
  kind: "speech",
  text,
  ts: Date.UTC(2026, 9, 10, 9, 5),
});

test("the space's synthesis instructions go into the live notes prompt, and nothing is added without them", async () => {
  const { agent, prompts } = await claudeAgent();
  await agent.notesFor(null, [seg("I'm blocked on the staging keys")], [], [], { instructions: INSTRUCTIONS });
  await agent.notesFor(null, [seg("I'm blocked on the staging keys")], [], [], { instructions: "  " });
  await agent.notesFor(null, [seg("I'm blocked on the staging keys")]);
  assert.match(prompts[0], /The team asked you to also do this when taking notes in this space:\n"""\nList blockers by person\.\nPull out customer quotes verbatim\.\n"""/);
  assert.match(prompts[0], /Still write every decision, action item and open question/);
  assert.equal(prompts[1], prompts[2]);
  assert.doesNotMatch(prompts[1], /The team asked/);
});

test("the synthesis call gets the instructions and the transcript, and is skipped without instructions", async () => {
  const { agent, requests } = await claudeAgent();
  const note = { kind: "action" as const, text: "Get Huy the staging keys", owner: "Joe" };
  const items = [{ item: null, notes: [note], segments: [seg("I'm blocked on the staging keys"), seg("The export button is the first thing I look for", "Dana")] }];
  const out = await agent.synthesizeMeeting({ spaceName: "Platform", instructions: INSTRUCTIONS, items });
  assert.equal(out, "**Blockers**\n- Huy: waiting on the staging keys");
  assert.equal(requests.length, 1);
  const user = requests[0].messages[0].content;
  assert.match(user, /Space: Platform/);
  assert.match(user, /"""\nList blockers by person\.\nPull out customer quotes verbatim\.\n"""/);
  assert.match(user, /\[09:05\] Dana: The export button is the first thing I look for/);
  assert.match(user, /- action: Get Huy the staging keys \(Joe\)/);
  assert.match(requests[0].system, /Synthesis section/);

  assert.equal(await agent.synthesizeMeeting({ spaceName: "Platform", instructions: " \n ", items }), null);
  assert.equal(requests.length, 1);
});

/** A heuristic agent that records what the room hands it. */
function recordingAgent() {
  const contexts: Array<NotesContext | undefined> = [];
  const syntheses: SynthesisInput[] = [];
  const base = new HeuristicAgent();
  const agent: Agent = Object.assign(base, {
    notesFor: (async (item, segments, _earlier, _captured, context) => {
      contexts.push(context);
      return HeuristicAgent.prototype.notesFor.call(base, item, segments);
    }) as Agent["notesFor"],
    synthesizeMeeting: async (input: SynthesisInput) => {
      syntheses.push(input);
      return "- Huy: blocked on the staging keys";
    },
  });
  return { agent, contexts, syntheses };
}

test("a space with instructions gets them in its notes and a Synthesis on the meeting", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Platform");
  db.updateRoom(room.id, { synthesisInstructions: INSTRUCTIONS });
  const [item] = db.addItems(room.id, [{ source: "agenda" as const, externalId: null, title: "Staging", url: null, description: null }]);
  const { agent, contexts, syntheses } = recordingAgent();
  const session = new RoomSession(db, agent, db.getRoom(room.id)!, () => {});
  session.setFocus(item.id, "Joe", "manual");
  session.addSpeech("p1", "Huy", "I'm blocked on the staging keys, I'll ping Joe", Date.now());
  await session.end();

  assert.ok(contexts.length > 0);
  assert.ok(contexts.every((c) => c?.instructions === INSTRUCTIONS));
  assert.equal(syntheses.length, 1);
  assert.equal(syntheses[0].spaceName, "Platform");
  assert.equal(syntheses[0].instructions, INSTRUCTIONS);
  assert.deepEqual(
    syntheses[0].items.flatMap((g) => g.segments.map((s) => s.text)),
    ["I'm blocked on the staging keys, I'll ping Joe"],
  );
  assert.equal(db.getMeeting(session.meetingId)?.synthesis, "- Huy: blocked on the staging keys");
});

test("a space without instructions keeps today's notes and gets no Synthesis", async () => {
  const db = openDb(":memory:");
  const room = db.createRoom("Platform");
  const { agent, contexts, syntheses } = recordingAgent();
  const session = new RoomSession(db, agent, room, () => {});
  session.addSpeech("p1", "Huy", "I'll ping Joe about the staging keys", Date.now());
  await session.end();

  assert.ok(contexts.length > 0);
  assert.ok(contexts.every((c) => !c?.instructions));
  assert.equal(syntheses.length, 0);
  const m = db.getMeeting(session.meetingId)!;
  assert.equal(m.synthesis, null);
  assert.ok(m.endedAt);
});

test("the brief carries the space's instructions and the Synthesis, and leaves both out when there are none", () => {
  const meeting = { id: "m1", roomId: "r1", startedAt: Date.UTC(2026, 9, 10, 9), endedAt: Date.UTC(2026, 9, 10, 9, 20), summary: "Short one." };
  const note = (id: string, kind: Note["kind"], text: string): Note =>
    ({ id, meetingId: "m1", itemId: null, kind, text, owner: null, ts: 0, doneAt: null, doneBy: null, discussionId: null }) as Note;
  const groups = [{ item: null, segments: [seg("I'm blocked on the staging keys")], notes: [note("n1", "action", "Get Huy the keys")] }];
  const common = { roomName: "Platform", decks: [], baseUrl: "http://stand.test", withTranscript: false, groups };

  const brief = buildBrief({ ...common, meeting: { ...meeting, synthesis: "- Huy: blocked on the staging keys" }, synthesisInstructions: ` ${INSTRUCTIONS} ` });
  assert.equal(brief.schema, "stand.meeting-brief/v1");
  assert.deepEqual(brief.space, { id: "r1", name: "Platform", synthesisInstructions: INSTRUCTIONS });
  assert.equal(brief.synthesis, "- Huy: blocked on the staging keys");
  const md = briefToMarkdown(brief);
  assert.match(md, /\nsynthesis_instructions: "List blockers by person\.\\nPull out customer quotes verbatim\."\n/);
  assert.match(md, /\n## Synthesis\n\n- Huy: blocked on the staging keys\n/);

  const plain = buildBrief({ ...common, meeting });
  assert.equal(plain.space.synthesisInstructions, null);
  assert.equal(plain.synthesis, null);
  const plainMd = briefToMarkdown(plain);
  assert.doesNotMatch(plainMd, /synthesis/i);
});

// A scripted 4-person standup that plays into a live room, so the whole flow
// (pinning, the agent's screen suggestion, notes, history) can be seen
// without microphones or API keys.

import type { Item } from "../shared/protocol.ts";
import type { RoomSession } from "./room.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PEOPLE = {
  priya: { id: "demo-priya", name: "Priya" },
  sam: { id: "demo-sam", name: "Sam" },
  alex: { id: "demo-alex", name: "Alex" },
  jordan: { id: "demo-jordan", name: "Jordan" },
};
type Who = keyof typeof PEOPLE;

type Step =
  | { say: Who; text: string }
  | { chat: Who; text: string }
  | { focus: number }
  | { suggest: number; reason: string }
  | { accept: true }
  | { pause: number };

const label = (it: Item | undefined) => (it ? (it.externalId ?? it.title) : "the next item");

function script(items: Item[]): Step[] {
  const [a, b, c, d] = items;
  return [
    { focus: 0 },
    { say: "priya", text: `Okay, starting with ${label(a)}. I found the drop-off: step three asks for a workspace URL before people know what it is.` },
    { say: "sam", text: "Could we just generate one and let them rename it later?" },
    { say: "priya", text: "Yes, let's go with an auto-generated URL and an edit link. I'll ship that by Thursday." },
    { say: "alex", text: "Do we know if that breaks the invite links that are already out?" },
    { pause: 1500 },
    // Presenter scrolls to the next ticket; the agent notices from the screen.
    { suggest: 1, reason: `${label(b)} is open in the shared screen` },
    { say: "sam", text: "Next one is mine. The annual toggle is in review, design signed off yesterday." },
    { pause: 1200 },
    { accept: true },
    { say: "jordan", text: "One concern, the discount copy says 20 percent but billing gives 17." },
    { say: "sam", text: "Good catch. We agreed on 20 percent in planning, so billing is wrong. Jordan, can you file that against billing?" },
    { say: "jordan", text: "On it, I'll file it today." },
    { chat: "alex", text: "Billing config link: config/plans.yaml line 42" },
    { focus: 2 },
    { say: "alex", text: `${label(c)} hasn't started. I'll pick it up after the retry library upgrade.` },
    { say: "priya", text: "What's the max backoff going to be, an hour?" },
    { say: "alex", text: "Decided: cap it at one hour with jitter, and give up after 24 hours." },
    { focus: 3 },
    { say: "jordan", text: `${label(d)} failed four times this week, always the payment iframe timing out.` },
    { say: "sam", text: "Is it the test or the sandbox being slow?" },
    { say: "jordan", text: "I think it's the sandbox. I'll add a retry around the iframe load and look at the timing data by Friday." },
  ];
}

export async function runDemo(room: RoomSession, items: Item[]) {
  for (const step of script(items)) {
    if (room.isEnded) return;
    if ("say" in step) {
      const p = PEOPLE[step.say];
      const startedAt = Date.now();
      // Stream the words like live captions, then commit the utterance.
      const words = step.text.split(" ");
      for (let i = 3; i < words.length; i += 4) {
        room.interim(p.id, p.name, words.slice(0, i).join(" "));
        await sleep(220);
      }
      room.interim(p.id, p.name, "");
      room.addSpeech(p.id, p.name, step.text, startedAt);
      await sleep(900);
    } else if ("chat" in step) {
      const p = PEOPLE[step.chat];
      room.demoChat(p.id, p.name, step.text);
      await sleep(900);
    } else if ("focus" in step) {
      const it = items[step.focus];
      if (it) room.setFocus(it.id, "Demo presenter", "demo");
      await sleep(600);
    } else if ("suggest" in step) {
      const it = items[step.suggest];
      if (it) room.demoSuggest(it.id, step.reason);
      await sleep(400);
    } else if ("accept" in step) {
      room.demoAccept();
      await sleep(600);
    } else {
      await sleep(step.pause);
    }
  }
}

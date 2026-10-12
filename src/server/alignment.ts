// Alignment meetings: the board the agent keeps as people talk (the question, the proposal on
// the table and each person's likely answer to it, where each person stands, what they differ
// on and already agree on), and how a run's changes are applied to it.
// Each run gets the board as it stands plus what was said since, and returns only what changed,
// so a run stays small however long the meeting goes.
import type { AlignmentState, AlignmentVote, Segment } from "../shared/protocol.ts";

/** At most this many of each, so the board stays one screen and the runs stay small. */
const MAX_REASONS = 3;
const MAX_DIFFER = 2;
const MAX_AGREED = 10;
const MAX_UNANSWERED = 6;
const MAX_PARKED = 8;

export const emptyAlignment = (): AlignmentState => ({
  question: null,
  positions: [],
  differ: [],
  settleTest: null,
  agreed: [],
  unanswered: [],
  parked: [],
  proposal: null,
  landing: null,
});

export const ANSWERS: AlignmentVote[] = ["agree", "live_with", "concern", "block"];

/** The next meeting on the same question starts from where this one stood: positions, what
 *  they differ on and agree on, the open test and questions, and what was on the table with
 *  its concern. Not where it landed, who moved, or anyone's answers: those are asked again. */
export function carryOver(prev: AlignmentState): AlignmentState {
  const p = prev.proposal ?? null;
  return {
    ...structuredClone(prev),
    positions: prev.positions.map((x) => ({ ...x, movedAt: null, movedBecause: null })),
    proposal: p ? { text: p.text, at: null, rewrittenAt: null, guesses: [], concern: p.concern ? { ...p.concern } : null } : null,
    landing: null,
  };
}

/** Whether an edited line is still the same one: a typo or a few words changed, not a new
 *  question or proposal. Compares the words, so it doesn't matter how long the line is. */
export function sameGist(a: string, b: string) {
  const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  // Edit distance over words.
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length] / Math.max(x.length, y.length) < 0.3;
}

/** What one run says changed. `line` numbers point into the lines the run was given (1-based). */
export interface AlignmentDraft {
  /** Only when no question is set (a suggestion), or to add why it matters now. */
  question: { text: string; askedBy: string | null; whyNow: string | null; line: number | null } | null;
  /** Only the people whose position is new or changed. */
  positions: Array<{ person: string; stance: string; reasons: string[]; moved: boolean; movedBecause: string | null; line: number | null }>;
  /** The whole list when it changed; null when it didn't. */
  differ: AlignmentState["differ"] | null;
  /** Null when unchanged. */
  settleTest: { text: string; proposedBy: string | null; answered: boolean; line: number | null } | null;
  agreedAdd: Array<{ text: string; by: string[]; line: number | null }>;
  /** Keys (A1, A2...) of agreed points someone has since disputed. */
  agreedRemove: string[];
  unansweredAdd: Array<{ asker: string; question: string; line: number | null }>;
  /** Keys (U1, U2...) of questions that got their answer. */
  answered: string[];
  parkedAdd: string[];
  /** The whole proposal when its text, a guess or the concern changed; null when nothing did.
   *  `same`: the same proposal reworded, so people's answers stand. */
  proposal: {
    text: string;
    same: boolean;
    guesses: Array<{ person: string; answer: AlignmentVote }>;
    concern: { person: string; text: string } | null;
    line: number | null;
  } | null;
  landing: AlignmentState["landing"];
}

export interface AlignmentInput {
  state: AlignmentState;
  /** What was said just before, already reflected in the board: for context only. */
  context: Segment[];
  /** What was said since the last run. */
  lines: Segment[];
  /** Who is in the meeting or spoke in it: positions are only ever written for them. */
  attendees: string[];
  /** The meeting is wrapping up: write where it landed. */
  closing: boolean;
  space: { name: string; purpose: string };
}

const norm = (name: string) => name.trim().toLowerCase();
const first = (name: string) => norm(name).split(/\s+/)[0] ?? "";

/** The attendee a name the model wrote refers to: the same name, or the same first name. */
export function matchAttendee(name: string, attendees: string[]): string | null {
  const n = norm(name);
  if (!n) return null;
  return attendees.find((a) => norm(a) === n) ?? attendees.find((a) => first(a) === first(n)) ?? null;
}

/** The board as the prompt shows it, with keys the model can point back at. */
export function boardText(s: AlignmentState): string {
  const q = s.question
    ? `Question${s.question.suggested ? " (your suggestion, not confirmed)" : ""}: ${s.question.text}${s.question.askedBy ? ` (asked by ${s.question.askedBy})` : ""}${
        s.question.whyNow ? `\nWhy it matters now: ${s.question.whyNow}` : ""
      }`
    : "Question: not set yet";
  const positions = s.positions.length
    ? s.positions.map((p) => `- ${p.person}: ${p.stance}${p.reasons.length ? `\n  Reasons: ${p.reasons.join(" | ")}` : ""}`).join("\n")
    : "- none yet";
  const differ = s.differ.length
    ? s.differ.map((d) => `- ${d.question} (${d.sides.map((x) => `${x.person}: ${x.gist}`).join("; ")})`).join("\n")
    : "- none yet";
  const test = s.settleTest
    ? `${s.settleTest.text}${s.settleTest.proposedBy ? ` (proposed by ${s.settleTest.proposedBy})` : ""}, ${s.settleTest.answered ? "answered" : "not answered yet"}`
    : "none yet";
  const agreed = s.agreed.length ? s.agreed.map((a, i) => `- A${i + 1} ${a.text}`).join("\n") : "- none yet";
  const waiting = s.unanswered.length ? s.unanswered.map((u, i) => `- U${i + 1} ${u.asker}: ${u.question}`).join("\n") : "- none";
  const parked = s.parked.length ? s.parked.join("; ") : "none";
  const p = s.proposal;
  const table = p
    ? `${p.text}\nGuessed answers: ${p.guesses.length ? p.guesses.map((g) => `${g.person}: ${g.answer}`).join("; ") : "none yet"}\nHolding it up: ${p.concern ? `${p.concern.person}: ${p.concern.text}` : "nothing"}`
    : "nothing yet";
  return `${q}

On the table: ${table}

Positions:
${positions}

Where they differ:
${differ}

What would settle it: ${test}

Agreed so far:
${agreed}

Waiting on an answer:
${waiting}

Parked: ${parked}`;
}

/** The board after one run: `draft`'s changes applied to `state`. Times come from the lines the
 *  run was given; names the model wrote are mapped to attendees, and anyone else is dropped. */
export function applyAlignment(state: AlignmentState, draft: AlignmentDraft, lines: Segment[], attendees: string[], now = Date.now()): AlignmentState {
  const at = (line: number | null | undefined) => (line && lines[line - 1] ? lines[line - 1].ts : now);
  const who = (name: string | null | undefined) => (name ? (matchAttendee(name, attendees) ?? null) : null);
  const clip = (t: string, max: number) => t.trim().replace(/\s+/g, " ").slice(0, max);
  const next: AlignmentState = structuredClone(state);

  const q = draft.question;
  if (q && clip(q.text, 300)) {
    if (!next.question || next.question.suggested) {
      next.question = { text: clip(q.text, 300), askedBy: who(q.askedBy), at: at(q.line), whyNow: q.whyNow ? clip(q.whyNow, 300) : null, suggested: true };
    } else if (!next.question.whyNow && q.whyNow) {
      // Set by a person: the agent never rewrites it, only says why it matters now.
      next.question.whyNow = clip(q.whyNow, 300);
    }
  }

  for (const p of draft.positions) {
    const person = who(p.person);
    const stance = clip(p.stance, 300);
    if (!person || !stance) continue;
    const reasons = p.reasons.map((r) => clip(r, 240)).filter(Boolean).slice(0, MAX_REASONS);
    const had = next.positions.find((x) => x.person === person);
    if (had) {
      const moved = p.moved && norm(had.stance) !== norm(stance);
      had.stance = stance;
      if (reasons.length) had.reasons = reasons;
      if (moved) {
        had.movedAt = at(p.line);
        had.movedBecause = p.movedBecause ? clip(p.movedBecause, 240) : null;
      }
    } else {
      next.positions.push({ person, stance, reasons, movedAt: null, movedBecause: null });
    }
  }

  if (draft.differ) {
    next.differ = draft.differ
      .map((d) => ({
        question: clip(d.question, 240),
        sides: d.sides.flatMap((x) => {
          const person = who(x.person);
          return person && clip(x.gist, 160) ? [{ person, gist: clip(x.gist, 160) }] : [];
        }),
      }))
      .filter((d) => d.question)
      .slice(0, MAX_DIFFER);
  }

  const t = draft.settleTest;
  if (t && clip(t.text, 240)) {
    const same = next.settleTest && norm(next.settleTest.text) === norm(t.text);
    next.settleTest = {
      text: clip(t.text, 240),
      proposedBy: who(t.proposedBy) ?? (same ? next.settleTest!.proposedBy : null),
      at: same ? next.settleTest!.at : at(t.line),
      answered: Boolean(t.answered),
    };
  }

  const keyed = (prefix: string, keys: string[], n: number) =>
    new Set(keys.map((k) => /^([A-Z])(\d+)$/.exec(k.trim().toUpperCase())).flatMap((m) => (m && m[1] === prefix && +m[2] >= 1 && +m[2] <= n ? [+m[2] - 1] : [])));
  const dropAgreed = keyed("A", draft.agreedRemove, next.agreed.length);
  next.agreed = next.agreed.filter((_, i) => !dropAgreed.has(i));
  for (const a of draft.agreedAdd) {
    const text = clip(a.text, 240);
    if (!text || next.agreed.some((x) => norm(x.text) === norm(text))) continue;
    next.agreed.push({ text, at: at(a.line), by: [...new Set(a.by.map(who).filter((x): x is string => Boolean(x)))] });
  }
  next.agreed = next.agreed.slice(-MAX_AGREED);

  const done = keyed("U", draft.answered, next.unanswered.length);
  next.unanswered = next.unanswered.filter((_, i) => !done.has(i));
  for (const u of draft.unansweredAdd) {
    const question = clip(u.question, 240);
    if (!question || next.unanswered.some((x) => norm(x.question) === norm(question))) continue;
    next.unanswered.push({ asker: who(u.asker) ?? clip(u.asker, 60), question, at: at(u.line) });
  }
  next.unanswered = next.unanswered.slice(-MAX_UNANSWERED);

  for (const p of draft.parkedAdd) {
    const text = clip(p, 80);
    if (text && !next.parked.some((x) => norm(x) === norm(text))) next.parked.push(text);
  }
  next.parked = next.parked.slice(-MAX_PARKED);

  const p = draft.proposal;
  const text = p ? clip(p.text, 400) : "";
  if (p && text) {
    const had = next.proposal;
    // A different proposal starts over; the same one reworded keeps when it was put forward.
    const fresh = !had || (!p.same && !sameGist(had.text, text));
    const guesses = new Map<string, AlignmentVote>();
    for (const g of p.guesses) {
      const person = who(g.person);
      if (person && ANSWERS.includes(g.answer)) guesses.set(person, g.answer);
    }
    const concernBy = p.concern ? who(p.concern.person) : null;
    next.proposal = {
      text,
      at: fresh ? at(p.line) : had!.at,
      rewrittenAt: fresh ? null : norm(had!.text) === norm(text) ? had!.rewrittenAt : at(p.line),
      guesses: [...guesses].map(([person, answer]) => ({ person, answer })),
      concern: p.concern && concernBy && clip(p.concern.text, 200) ? { person: concernBy, text: clip(p.concern.text, 200) } : null,
    };
  }

  if (draft.landing && clip(draft.landing.text, 400)) {
    const l = draft.landing;
    next.landing = {
      outcome: l.outcome,
      text: clip(l.text, 400),
      reopens: l.reopens ? clip(l.reopens, 200) : null,
      changesIf: l.changesIf ? clip(l.changesIf, 240) : null,
      stillOpen: l.stillOpen ? clip(l.stillOpen, 240) : null,
      nextSteps: l.nextSteps.flatMap((s) => (clip(s.text, 200) ? [{ owner: who(s.owner), text: clip(s.text, 200) }] : [])).slice(0, 6),
    };
  }
  return next;
}

/** Without a model: each speaker's latest longer remark as where they stand, and questions
 *  nobody answered. Enough to see the board work. */
export function heuristicAlignment(input: AlignmentInput): AlignmentDraft {
  const draft: AlignmentDraft = {
    question: null,
    positions: [],
    differ: null,
    settleTest: null,
    agreedAdd: [],
    agreedRemove: [],
    unansweredAdd: [],
    answered: [],
    parkedAdd: [],
    proposal: null,
    landing: null,
  };
  const latest = new Map<string, { text: string; line: number }>();
  input.lines.forEach((s, i) => {
    if (s.text.split(/\s+/).length >= 6) latest.set(s.speakerName, { text: s.text, line: i + 1 });
    const next = input.lines[i + 1];
    if (/\?\s*$/.test(s.text) && (!next || next.speakerName === s.speakerName)) {
      draft.unansweredAdd.push({ asker: s.speakerName, question: s.text, line: i + 1 });
    }
  });
  for (const [person, { text, line }] of latest) draft.positions.push({ person, stance: text.slice(0, 160), reasons: [], moved: false, movedBecause: null, line });
  if (!input.state.question) {
    const asked = input.lines.findIndex((s) => /\?\s*$/.test(s.text));
    if (asked >= 0) draft.question = { text: input.lines[asked].text, askedBy: input.lines[asked].speakerName, whyNow: null, line: asked + 1 };
  }
  // On the table: the latest suggestion someone made ("we should…", "let's…"), with each
  // speaker's answer guessed from their own words.
  const proposed = [...input.lines.entries()].reverse().find(([, s]) => /\b(we should|let's|let us|i propose|how about|keep|go with)\b/i.test(s.text) && !/\?\s*$/.test(s.text));
  const table = proposed ? proposed[1].text.slice(0, 200) : input.state.proposal?.text;
  if (table) {
    const guesses = new Map<string, AlignmentVote>((input.state.proposal?.guesses ?? []).map((g) => [g.person, g.answer]));
    if (proposed) guesses.set(proposed[1].speakerName, "agree");
    let concern = input.state.proposal?.concern ?? null;
    for (const s of input.lines) {
      if (proposed && s === proposed[1]) continue;
      const answer = guessAnswer(s.text);
      if (!answer) continue;
      guesses.set(s.speakerName, answer);
      if (answer === "concern" || answer === "block") concern = { person: s.speakerName, text: s.text.slice(0, 160) };
    }
    draft.proposal = {
      text: table,
      same: Boolean(input.state.proposal && sameGist(input.state.proposal.text, table)),
      guesses: [...guesses].map(([person, answer]) => ({ person, answer })),
      concern,
      line: proposed ? proposed[0] + 1 : null,
    };
  }
  if (input.closing) {
    const p = draft.proposal ?? input.state.proposal;
    draft.landing = {
      outcome: "held",
      text: p ? p.text : input.state.question ? `Not decided yet: ${input.state.question.text}` : "Not decided yet",
      reopens: "The next meeting",
      changesIf: null,
      stillOpen: input.state.unanswered[0]?.question ?? null,
      nextSteps: [],
    };
  }
  return draft;
}

/** Without a model: an answer only when the words say it plainly. */
function guessAnswer(text: string): AlignmentVote | null {
  if (/\b(no way|i'd block|i would block|can't accept|cannot accept|won't go along)\b/i.test(text)) return "block";
  if (/\b(can live with|could live with|fine with it|i'll go along|okay with it)\b/i.test(text)) return "live_with";
  if (/\b(but|concern|worried|not sure|unless|counter)\b/i.test(text)) return "concern";
  if (/\b(agree|yes|sounds good|makes sense|works for me|can't argue)\b/i.test(text)) return "agree";
  return null;
}

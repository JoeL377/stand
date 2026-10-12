// Alignment meetings: the board the agent keeps as people talk (the question, the options on
// the table with who leans toward each, where each person stands, what they differ on and
// already agree on), and how a run's changes are applied to it.
// Each run gets the board as it stands plus what was said since, and returns only what changed,
// so a run stays small however long the meeting goes.
import type { AlignmentOption, AlignmentState, Segment } from "../shared/protocol.ts";

/** At most this many of each, so the board stays one screen and the runs stay small. */
const MAX_REASONS = 3;
const MAX_DIFFER = 2;
const MAX_AGREED = 10;
const MAX_UNANSWERED = 6;
const MAX_PARKED = 8;
/** More than three options stops reading as a choice. */
export const MAX_OPTIONS = 3;

export const emptyAlignment = (): AlignmentState => ({
  question: null,
  positions: [],
  differ: [],
  settleTest: null,
  agreed: [],
  unanswered: [],
  parked: [],
  options: [],
  gaining: null,
  landing: null,
});

/** The next meeting on the same question starts from where this one stood: positions, what
 *  they differ on and agree on, the open test and questions, and the options on the table.
 *  Not where it landed, who moved, or who leans where: those are asked again. */
export function carryOver(prev: AlignmentState): AlignmentState {
  return {
    ...structuredClone(prev),
    positions: prev.positions.map((x) => ({ ...x, movedAt: null, movedBecause: null })),
    options: (prev.options ?? []).map((o) => ({ ...o, at: null, leaning: [] })),
    gaining: null,
    landing: null,
  };
}

/** An id for a new option, unlike any in `taken`. */
function optionId(taken: Array<{ id: string }>) {
  for (;;) {
    const id = `o${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.some((o) => o.id === id)) return id;
  }
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
  /** The whole list of options when any changed; null (or empty) when none did. `key` is the
   *  option's key on the board (O1, O2...) when it's the same option, maybe reworded, so
   *  people's leans stand; null for a new one. */
  options: Array<{
    key: string | null;
    title: string;
    detail: string | null;
    gain: string | null;
    cost: string | null;
    leaning: string[];
    gaining: boolean;
    line: number | null;
  }> | null;
  /** `option`: the key of the option it landed on, numbered as in `options` when the run
   *  returned them, else as on the board. */
  landing: (Omit<NonNullable<AlignmentState["landing"]>, "option"> & { option: string | null }) | null;
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
  /** Who tapped which option (by its id): where they lean, in their own words. */
  taps?: Array<{ person: string; option: string }>;
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

/** Who leans toward an option: their own taps, then the agent's read of everyone else. */
function leaners(o: AlignmentOption, taps: Array<{ person: string; option: string }>) {
  const tapped = (p: string) => taps.some((t) => t.person === p || first(t.person) === first(p));
  return [...taps.filter((t) => t.option === o.id).map((t) => `${t.person} (tapped)`), ...o.leaning.filter((p) => !tapped(p))];
}

/** The board as the prompt shows it, with keys the model can point back at. */
export function boardText(s: AlignmentState, taps: Array<{ person: string; option: string }> = []): string {
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
  const options = s.options.length
    ? s.options
        .map(
          (o, i) =>
            `- O${i + 1} ${o.title}${o.detail ? ` (${o.detail})` : ""}${s.gaining === o.id ? " [gaining]" : ""}\n  Gains: ${o.gain ?? "-"} | Costs: ${o.cost ?? "-"} | Leaning: ${
              leaners(o, taps).join(", ") || "nobody yet"
            }`,
        )
        .join("\n")
    : "- none yet";
  return `${q}

Options on the table:
${options}

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

  if (draft.options?.length) {
    const before = next.options;
    const opts: AlignmentOption[] = [];
    const placed = new Set<string>();
    let gaining: string | null = null;
    for (const o of draft.options) {
      const title = clip(o.title, 80);
      if (!title || opts.length >= MAX_OPTIONS) continue;
      // The same option reworded keeps its id, and so people's leans: by its key, else by its gist.
      const k = /^O(\d+)$/i.exec(o.key?.trim() ?? "");
      const had = (k ? before[+k[1] - 1] : undefined) ?? before.find((x) => sameGist(x.title, title));
      const same = had && !opts.some((x) => x.id === had.id) ? had : null;
      // Each person leans one way: the first option that names them keeps them.
      const leaning = o.leaning.map(who).filter((x): x is string => Boolean(x && !placed.has(x)));
      for (const x of leaning) placed.add(x);
      const option: AlignmentOption = {
        id: same?.id ?? optionId([...before, ...opts]),
        title,
        detail: o.detail ? clip(o.detail, 120) || null : null,
        gain: o.gain ? clip(o.gain, 100) || null : null,
        cost: o.cost ? clip(o.cost, 100) || null : null,
        at: same ? same.at : at(o.line),
        leaning: [...new Set(leaning)],
      };
      opts.push(option);
      if (o.gaining && !gaining) gaining = option.id;
    }
    if (opts.length) {
      next.options = opts;
      next.gaining = gaining;
    }
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
      option: next.options[Number(/^O(\d+)$/i.exec(l.option?.trim() ?? "")?.[1] ?? 0) - 1]?.id ?? null,
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
    options: null,
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
  // Options: each suggestion someone made ("we should…", "let's…"), with its speaker leaning
  // toward it, and anyone who then agrees leaning toward the latest one.
  const opts: NonNullable<AlignmentDraft["options"]> = input.state.options.map((o, i) => ({
    key: `O${i + 1}`,
    title: o.title,
    detail: o.detail,
    gain: o.gain,
    cost: o.cost,
    leaning: [...o.leaning],
    gaining: o.id === input.state.gaining,
    line: null,
  }));
  const lean = (person: string, o: (typeof opts)[number]) => {
    for (const x of opts) x.leaning = x.leaning.filter((p) => p !== person);
    o.leaning.push(person);
  };
  let leading = opts.find((o) => o.gaining) ?? null;
  let changed = false;
  input.lines.forEach((s, i) => {
    if (SUGGEST.test(s.text) && !/\?\s*$/.test(s.text)) {
      const title = s.text.length > 60 ? `${s.text.slice(0, 60).replace(/\s+\S*$/, "")}…` : s.text;
      let o = opts.find((x) => sameGist(x.title, title));
      if (!o) {
        o = { key: null, title, detail: null, gain: null, cost: null, leaning: [], gaining: false, line: i + 1 };
        opts.push(o);
      }
      lean(s.speakerName, o);
      leading = o;
      changed = true;
    } else if (leading && AGREE.test(s.text)) {
      lean(s.speakerName, leading);
      changed = true;
    }
  });
  if (changed) {
    for (const o of opts) o.gaining = o === leading;
    draft.options = opts.slice(-MAX_OPTIONS);
  }
  if (input.closing) {
    // Where most people lean, by their own taps first; ties go to the one gaining ground.
    const list = draft.options ?? opts;
    const taps = input.taps ?? [];
    const count = (o: (typeof list)[number]) => {
      const had = o.key ? input.state.options[Number(o.key.slice(1)) - 1] : undefined;
      const tapped = taps.filter((t) => t.option === had?.id);
      return tapped.length + o.leaning.filter((p) => !taps.some((t) => t.person === p)).length;
    };
    const landed = [...list].sort((a, b) => count(b) - count(a) || Number(b.gaining) - Number(a.gaining))[0] ?? null;
    draft.landing = {
      outcome: "held",
      text: landed ? landed.title : input.state.question ? `Not decided yet: ${input.state.question.text}` : "Not decided yet",
      reopens: "The next meeting",
      changesIf: null,
      stillOpen: input.state.unanswered[0]?.question ?? null,
      nextSteps: [],
      option: landed ? `O${list.indexOf(landed) + 1}` : null,
    };
  }
  return draft;
}

const SUGGEST = /\b(we should|let's|let us|i propose|how about|keep|go with)\b/i;
/** Without a model: agreement only when the words say it plainly. */
const AGREE = /\b(agree|yes|sounds good|makes sense|works for me|can't argue|can live with)\b/i;

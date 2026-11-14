// Artifacts: the things a space made that people open again and reuse. Records (to-dos, decisions,
// questions) stay in their project and events stay in Activity; this is the library of what was made.
// Five kinds are read from what Stand already keeps (server/artifacts.ts): a to-do's plan, a review's
// deck, a brainstorm's or design session's sketch, a meeting's recap, and the screenshots on a to-do
// or the snaps of a meeting. The sixth, a doc, is a write-up an agent or a person saved (db/docs.ts).
// The server and the browser share this file.

export type ArtifactKind = "spec" | "deck" | "sketch" | "recap" | "screens" | "doc";

export const ARTIFACT_KINDS: ArtifactKind[] = ["spec", "deck", "sketch", "recap", "screens", "doc"];
/** What each kind is called: on a card, and on its filter. */
export const ARTIFACT_NAME: Record<ArtifactKind, { one: string; many: string }> = {
  spec: { one: "Spec", many: "Specs" },
  deck: { one: "Deck", many: "Decks" },
  sketch: { one: "Sketch", many: "Sketches" },
  recap: { one: "Recap", many: "Recaps" },
  screens: { one: "Screens", many: "Screens" },
  doc: { one: "Doc", many: "Docs" },
};

export const DOC_TITLE_MAX = 120;
export const DOC_TEXT_MAX = 100_000;

/** Who made an artifact, for the "Made by" filter. */
export interface ArtifactMaker {
  /** "stand", "p:<name>" for a person, "a:<person>:<agent>" for someone's agent. */
  key: string;
  /** "Priya’s Claude Code", "Sam", "Stand". */
  name: string;
}

/** Something an artifact is tied to: the to-do it is on, the meeting it came from, a PR built from it. */
export interface ArtifactLink {
  text: string;
  /** What it is to the artifact, in a few quiet words: "reviewed v2", "built from it". */
  note?: string;
  href?: string;
  /** A to-do: it opens in the drawer. */
  taskId?: string;
}

/** What a card draws for its kind, small. */
export interface ArtifactPreview {
  /** Spec, doc, recap: its first lines, as plain text. */
  text?: string;
  /** Screens, and a deck with pictures: the first few images. */
  images?: string[];
  /** Deck: its slides' names. */
  slides?: string[];
  /** Recap: what the meeting kept. */
  counts?: { todos: number; decided: number; open: number };
  /** Sketch: how it is drawn. */
  drawn?: "map" | "diagram";
}

export interface Artifact {
  /** "<kind>:<id of what it is read from>". */
  id: string;
  kind: ArtifactKind;
  title: string;
  /** When it was made or last changed. */
  ts: number;
  /** The projects it belongs to, most of it first. Empty: Unassigned. */
  projects: string[];
  makers: ArtifactMaker[];
  /** Where it came from when that says more than who made it: "Design session", "Product review". */
  origin?: string;
  /** A few characters in the card's corner: "v3", "7 slides", "41 min". */
  badge?: string;
  /** The page it has already, when it has one. */
  href?: string;
  /** The to-do it is on (a spec, its screenshots): Open shows that to-do. */
  taskId?: string;
  /** The meeting it came out of: its recap, the deck or sketch of a call, the snaps taken in it. */
  meetingId?: string;
  /** A doc's reference, for agents. */
  ref?: string;
  preview: ArtifactPreview;
}

export interface ArtifactList {
  artifacts: Artifact[];
}

/** One artifact opened: the whole of it, and what it is tied to. */
export interface ArtifactDetail extends Artifact {
  /** Spec and doc: the text, as markdown. Recap: the summary. */
  body?: string;
  /** Spec: every version, oldest first. */
  versions?: Array<{ id: string; ts: number; by: string; text: string }>;
  /** Screens: every picture. */
  images?: Array<{ url: string; caption: string | null }>;
  links: ArtifactLink[];
}

/** The makers of a list, each once, the busiest first. */
export function makersOf(artifacts: Artifact[]): Array<ArtifactMaker & { n: number }> {
  const seen = new Map<string, ArtifactMaker & { n: number }>();
  for (const a of artifacts)
    for (const m of a.makers) {
      const had = seen.get(m.key);
      if (had) had.n++;
      else seen.set(m.key, { ...m, n: 1 });
    }
  return [...seen.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** The artifacts a filter lets through. project "" is everything, "none" is Unassigned. */
export function filterArtifacts(artifacts: Artifact[], f: { kind?: ArtifactKind | ""; maker?: string; project?: string; meeting?: string }): Artifact[] {
  return artifacts.filter(
    (a) =>
      (!f.kind || a.kind === f.kind) &&
      (!f.meeting || a.meetingId === f.meeting) &&
      (!f.maker || a.makers.some((m) => m.key === f.maker)) &&
      (!f.project || (f.project === "none" ? a.projects.length === 0 : a.projects.includes(f.project))),
  );
}

/** "Sam, Leo’s Codex +2": the first two makers and how many more. */
export function makersLine(makers: ArtifactMaker[]): string {
  if (makers.length <= 2) return makers.map((m) => m.name).join(", ");
  return `${makers[0].name}, ${makers[1].name} +${makers.length - 2}`;
}

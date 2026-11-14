// Artifacts: the documents a space made on purpose and opens again. Four kinds: a to-do's plan (spec),
// a write-up saved to the space (doc, db/docs.ts), a review's or an uploaded deck, and a brainstorm's
// or design session's sketch. Each is in one project, or in none. Records (to-dos, decisions,
// questions) stay in their project, a meeting's recap stays the meeting, and screenshots are
// attachments: a to-do's show on its spec. The server and the browser share this file.

export type ArtifactKind = "spec" | "doc" | "deck" | "sketch";

export const ARTIFACT_KINDS: ArtifactKind[] = ["spec", "doc", "deck", "sketch"];
/** What each kind is called: on a card, and on its filter. */
export const ARTIFACT_NAME: Record<ArtifactKind, { one: string; many: string }> = {
  spec: { one: "Spec", many: "Specs" },
  deck: { one: "Deck", many: "Decks" },
  sketch: { one: "Sketch", many: "Sketches" },
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
  /** One of a deck's slides, with how the review ended it as its note. */
  slide?: boolean;
}

/** What a card draws for its kind, small. */
export interface ArtifactPreview {
  /** Spec, doc: its first lines, as plain text. */
  text?: string;
  /** Deck: its slides' names. */
  slides?: string[];
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
  /** The one project it is in. Empty: Unassigned. */
  projects: string[];
  makers: ArtifactMaker[];
  /** Whose it is, as its source says: a spec's to-do owner, the person who started a sketch's call.
   *  Left out where the source names no one (a deck), and the card falls back to who made it. */
  owner?: string;
  /** Where it came from when that says more than who made it: "Design session", "Product review". */
  origin?: string;
  /** A few characters in the card's corner: "v3", "7 slides", "41 min". */
  badge?: string;
  /** The page it has already, when it has one. */
  href?: string;
  /** A spec's to-do: Open shows that to-do. */
  taskId?: string;
  /** The meeting it came out of: the deck or sketch of a call. */
  meetingId?: string;
  /** A doc's reference, for agents. */
  ref?: string;
  preview: ArtifactPreview;
}

export interface ArtifactList {
  artifacts: Artifact[];
  /** The ones the person looking pinned, newest pin first: theirs alone. */
  pinned?: string[];
}

/** One artifact opened: the whole of it, and what it is tied to. */
export interface ArtifactDetail extends Artifact {
  /** Spec and doc: the text, as markdown. */
  body?: string;
  /** Spec: every version, oldest first. */
  versions?: Array<{ id: string; ts: number; by: string; text: string }>;
  /** Spec: the screenshots on its to-do. */
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

/** Whose it is, as a card says it: the person behind the first maker ("Priya", not "Priya’s Claude
 *  Code"), "Stand" for Stand's own, and "+N" when other people made it too. Empty when no one is known. */
export function ownerLine(makers: ArtifactMaker[]): string {
  const owners: string[] = [];
  for (const m of makers) {
    const who = m.key.startsWith("a:") ? m.name.split(/’s |'s /)[0] : m.name;
    if (who && !owners.includes(who)) owners.push(who);
  }
  if (!owners.length) return "";
  return owners.length === 1 ? owners[0] : `${owners[0]} +${owners.length - 1}`;
}

/** "Sam, Leo’s Codex +2": the first two makers and how many more. */
export function makersLine(makers: ArtifactMaker[]): string {
  if (makers.length <= 2) return makers.map((m) => m.name).join(", ");
  return `${makers[0].name}, ${makers[1].name} +${makers.length - 2}`;
}

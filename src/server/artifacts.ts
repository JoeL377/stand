// The space's Artifacts (shared/artifacts.ts): everything it made that people open again, newest
// first. Nothing here is stored twice: each kind is read from the table that already keeps it
// (task_plans, reviews, brainstorms, meetings, work_shots, snaps), and docs from their own.
// A row archived off the space page is left out, as it is everywhere else.

import { type Actor, parseActor } from "../shared/actors.ts";
import type { Artifact, ArtifactDetail, ArtifactLink, ArtifactList, ArtifactMaker } from "../shared/artifacts.ts";
import { projectOf, type ProjectGraph } from "../shared/projects.ts";
import type { Note } from "../shared/protocol.ts";
import { archivedRows } from "./archive.ts";
import { brainstormsOf } from "./brainstorm.ts";
import type { DB } from "./db.ts";
import type { DocRow } from "./db/docs.ts";
import type { Row } from "./db/rows.ts";
import { meetingKindName } from "./meetingNames.ts";
import { prOf, shotUrl } from "./workLog.ts";

/** How much of a text a card can show. */
const PREVIEW = 420;
const MAX_IMAGES = 3;

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STAND: ArtifactMaker = { key: "stand", name: "Stand" };

/** Who made something, from its actor or, for rows from before actors were kept, its "who" string. */
export function makerOf(actor: Actor | null | undefined, by?: string | null): ArtifactMaker | null {
  const a = actor ?? parseActor(by);
  if (!a) return null;
  if (a.kind === "stand") return STAND;
  if (a.kind === "github") return { key: "github", name: "GitHub" };
  const person = a.person?.trim() ?? "";
  if (a.kind === "agent") {
    const agent = a.agent?.trim() || "Agent";
    return { key: `a:${person.toLowerCase()}:${agent.toLowerCase()}`, name: person ? `${first(person)}’s ${agent}` : agent };
  }
  return person ? { key: `p:${person.toLowerCase()}`, name: first(person) } : null;
}
const makers = (all: Array<ArtifactMaker | null>): ArtifactMaker[] => {
  const seen = new Map<string, ArtifactMaker>();
  for (const m of all) if (m && !seen.has(m.key)) seen.set(m.key, m);
  return [...seen.values()];
};

/** A markdown text as a card reads it: no marks, the title line left out when it only repeats the title. */
export function plainPreview(markdown: string, title?: string): string {
  const lines = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    // A table's rule row says nothing, and its bars are only marks.
    .filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l) || !l.includes("-"))
    .map((l) => l.replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/, "").replace(/^\s*\||\|\s*$/g, "").replace(/\s*\|\s*/g, ", ").replace(/[*_`]/g, "").trim())
    .filter(Boolean);
  if (title && lines[0] && lines[0].toLowerCase() === title.toLowerCase()) lines.shift();
  return clip(lines.join(" · "), PREVIEW);
}

/** A plan's own title: its first heading, when it has one. */
const headingOf = (markdown: string): string | null => {
  const m = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m.exec(markdown.slice(0, 2000));
  return m ? clip(m[1].replace(/[*_`]/g, ""), 120) : null;
};

/** The ids, most frequent first. */
const byCount = (ids: Array<string | null | undefined>): string[] => {
  const n = new Map<string, number>();
  for (const id of ids) if (id) n.set(id, (n.get(id) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([id]) => id);
};

const artifactHref = (roomId: string, id: string) => `/s/${roomId}?artifact=${encodeURIComponent(id)}`;
export const docRef = (id: string) => `stand:doc/${id}`;
/** A doc's id from "stand:doc/<id>", "doc/<id>" or a link to it in the web app. */
export function parseDocRef(input: string): string | null {
  const m = /(?:^|stand:)doc\/([a-z0-9]{6,24})\b/i.exec(input.trim()) ?? /[?&]artifact=doc(?::|%3A)([a-z0-9]{6,24})\b/i.exec(input);
  return m ? m[1] : null;
}

/** What the readers below share: the space's project rules, what was archived, and its meetings' names. */
function reading(db: DB, roomId: string) {
  const graph: ProjectGraph = db.projectGraph(roomId);
  const live = new Set(db.listProjects(roomId, graph).filter((p) => !p.archived).map((p) => p.id));
  const gone = new Set(archivedRows(db, roomId).map((a) => a.ref));
  const projectOfNote = (noteId: string | null | undefined): string | null => {
    const n = noteId ? graph.notes[noteId] : undefined;
    const p = n ? projectOf(n, graph) : null;
    return p && live.has(p) ? p : null;
  };
  const projectOfItem = (itemId: string | null | undefined): string | null => {
    const p = itemId ? (graph.items[itemId]?.projectId ?? null) : null;
    return p && live.has(p) ? p : null;
  };
  const meetingNames = new Map<string, string>();
  const meetingName = (id: string) => {
    let name = meetingNames.get(id);
    if (name === undefined) {
      const r = db.raw.prepare("SELECT title FROM meetings WHERE id = ?").get(id) as Row | undefined;
      name = ((r?.title as string) ?? "").trim() || meetingKindName(db, id);
      meetingNames.set(id, name);
    }
    return name;
  };
  return { graph, live, gone, projectOfNote, projectOfItem, meetingName };
}
type Reading = ReturnType<typeof reading>;

/** The to-dos these ids name that are still on the space's page. */
function tasks(db: DB, r: Reading, ids: string[]): Map<string, Note> {
  const out = new Map<string, Note>();
  for (const n of db.notesByIds([...new Set(ids)])) if (!r.gone.has(`todo:${n.id}`)) out.set(n.id, n);
  return out;
}

function specs(db: DB, roomId: string, r: Reading): Artifact[] {
  const rows = db.raw
    .prepare(
      `SELECT p.note_id, p.made_by, p.made_actor_json, p.made_at, substr(p.text, 1, 2400) AS head,
         (SELECT COUNT(*) FROM task_plans v WHERE v.note_id = p.note_id) AS versions
       FROM task_plans p WHERE p.room_id = ?
         AND p.rowid = (SELECT rowid FROM task_plans l WHERE l.note_id = p.note_id ORDER BY l.made_at DESC, l.rowid DESC LIMIT 1)`,
    )
    .all(roomId) as Row[];
  const notes = tasks(db, r, rows.map((x) => x.note_id as string));
  return rows.flatMap((x): Artifact[] => {
    const note = notes.get(x.note_id as string);
    if (!note) return [];
    const head = x.head as string;
    const title = headingOf(head) ?? clip(note.text, 120);
    const project = r.projectOfNote(note.id);
    return [{
      id: `spec:${note.id}`,
      kind: "spec",
      title,
      ts: x.made_at as number,
      projects: project ? [project] : [],
      makers: makers([makerOf(x.made_actor_json ? (JSON.parse(x.made_actor_json as string) as Actor) : null, x.made_by as string)]),
      badge: `v${x.versions as number}`,
      taskId: note.id,
      preview: { text: plainPreview(head, title) },
    }];
  });
}

function decks(db: DB, roomId: string, r: Reading): Artifact[] {
  const out: Artifact[] = [];
  for (const kind of ["product", "ideas"] as const) {
    const ran = kind === "product" ? db.reviewsDone(roomId) : db.ideaReviews(roomId).filter((v) => v.status === "done");
    for (const v of ran) {
      if (v.meetingId && r.gone.has(`meeting:${v.meetingId}`)) continue;
      const slides = db.reviewSlides(v.id);
      if (!slides.length) continue;
      const named = v.meetingId ? r.meetingName(v.meetingId) : null;
      const plain = kind === "product" ? "Product review" : "Idea review";
      out.push({
        id: `deck:${v.id}`,
        kind: "deck",
        title: v.title?.trim() || named || plain,
        ts: v.endedAt ?? v.startedAt ?? v.createdAt,
        projects: byCount(slides.map((s) => r.projectOfNote(s.noteId))),
        makers: makers(slides.map((s) => makerOf(null, s.addedBy))),
        origin: plain,
        badge: plural(slides.length, "slide"),
        href: `/s/${roomId}/review/${v.id}`,
        preview: { slides: slides.slice(0, 4).map((s) => (s.name || s.title).trim()) },
      });
    }
  }
  // Decks people uploaded or wrote, still on the agenda. A review's own deck is the review above.
  const uploaded = db.raw
    .prepare("SELECT d.* FROM decks d WHERE d.room_id = ? AND d.review_id IS NULL AND EXISTS (SELECT 1 FROM items i WHERE i.deck_id = d.id AND i.archived = 0)")
    .all(roomId) as Row[];
  for (const d of uploaded) {
    if (r.gone.has(`deck:${d.id as string}`)) continue;
    const project = r.projectOfItem(d.parent_item_id as string | null);
    out.push({
      id: `deck:u-${d.id as string}`,
      kind: "deck",
      title: d.title as string,
      ts: d.created_at as number,
      projects: project ? [project] : [],
      makers: [],
      origin: "Deck",
      badge: plural(d.page_count as number, "slide"),
      href: `/decks/${d.id as string}`,
      preview: {},
    });
  }
  return out;
}

function sketches(db: DB, roomId: string, r: Reading): Artifact[] {
  const rows = new Map(db.brainstorms(roomId, 100).map((b) => [b.id, b]));
  return brainstormsOf(db, roomId).flatMap((s): Artifact[] => {
    const b = rows.get(s.id);
    if (!b || s.status !== "done" || (b.meetingId && r.gone.has(`meeting:${b.meetingId}`))) return [];
    const held = s.subjects?.length ? s.subjects.reduce((n, x) => n + x.count, 0) : s.design ? s.design.boxes : s.directions + s.ideas;
    if (!held) return [];
    const design = b.kind === "design";
    const diagram = s.subjects?.length ? s.subjects[0].style !== "map" : design;
    const projects = byCount([r.projectOfNote(b.taskId), ...(s.subjects ?? []).map((x) => r.projectOfNote(x.taskId)), r.projectOfItem(b.itemId)]);
    return [{
      id: `sketch:${b.id}`,
      kind: "sketch",
      title: clip(s.prompt, 120),
      ts: b.endedAt ?? b.startedAt,
      projects,
      makers: [STAND],
      origin: design ? "Design session" : "Brainstorm",
      badge: s.subjects && s.subjects.length > 1 ? plural(s.subjects.length, "subject") : diagram ? plural(held, "box", "boxes") : plural(s.ideas || held, "idea"),
      href: `/s/${roomId}/brainstorm/${b.id}`,
      preview: { drawn: diagram ? "diagram" : "map" },
    }];
  });
}

function recaps(db: DB, roomId: string, r: Reading): Artifact[] {
  const meetings = db.feedMeetings(roomId, 100).filter((m) => !r.gone.has(`meeting:${m.id}`) && (m.summary?.trim() || m.todos + m.decided + m.open > 0));
  if (!meetings.length) return [];
  const kept = db.raw
    .prepare(`SELECT id, meeting_id FROM notes WHERE kind IN ('action', 'decision', 'question') AND meeting_id IN (${meetings.map(() => "?").join(",")})`)
    .all(...meetings.map((m) => m.id)) as Row[];
  return meetings.map((m): Artifact => ({
    id: `recap:${m.id}`,
    kind: "recap",
    title: m.title?.trim() || meetingKindName(db, m.id),
    ts: m.endedAt,
    // A meeting touches many projects; its recap is filed under the one most of it was about.
    projects: byCount(kept.filter((n) => n.meeting_id === m.id).map((n) => r.projectOfNote(n.id as string))).slice(0, 1),
    makers: [STAND],
    badge: `${Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000))} min`,
    href: `/meetings/${m.id}`,
    preview: { text: m.summary ? clip(m.summary, PREVIEW) : undefined, counts: { todos: m.todos, decided: m.decided, open: m.open } },
  }));
}

interface Shot {
  url: string;
  caption: string | null;
  ts: number;
}
const DAY = 86_400_000;

/** The pictures behind every Screens artifact of a space, by the artifact's id. */
function screenSets(db: DB, roomId: string, r: Reading): Array<{ artifact: Omit<Artifact, "preview" | "badge" | "ts">; shots: Shot[] }> {
  const out: Array<{ artifact: Omit<Artifact, "preview" | "badge" | "ts">; shots: Shot[] }> = [];

  // What agents attached to a to-do's log. A review slide's own pictures ("review:…") stay with its deck.
  const work = (db.raw.prepare("SELECT * FROM work_shots WHERE room_id = ? AND note_id NOT LIKE 'review:%' ORDER BY ts").all(roomId) as Row[]).map((x) => ({
    noteId: x.note_id as string,
    maker: makerOf(x.client ? { kind: "agent", person: x.user_name as string, agent: x.client as string } : { kind: "person", person: x.user_name as string }),
    shot: { url: shotUrl({ id: x.id as string, ext: x.ext as string }), caption: (x.caption as string) ?? null, ts: x.ts as number },
  }));
  const notes = tasks(db, r, work.map((w) => w.noteId));
  for (const [noteId, note] of notes) {
    const mine = work.filter((w) => w.noteId === noteId);
    const project = r.projectOfNote(noteId);
    out.push({
      artifact: { id: `screens:t-${noteId}`, kind: "screens", title: clip(note.text, 120), projects: project ? [project] : [], makers: makers(mine.map((w) => w.maker)), taskId: noteId },
      shots: mine.map((w) => w.shot),
    });
  }

  // Snaps: of a meeting, pinned to a note from the bar, or saved to the space on their own.
  const snaps = (db.raw.prepare("SELECT * FROM snaps WHERE room_id = ? ORDER BY ts").all(roomId) as Row[]).filter((s) => !r.gone.has(`snap:${s.id as string}`));
  const groups = new Map<string, Row[]>();
  for (const s of snaps) {
    const key = s.meeting_id ? `m-${s.meeting_id as string}` : s.jot_id ? `j-${s.jot_id as string}` : `d-${Math.floor((s.ts as number) / DAY)}-${((s.taken_by_id as string) ?? (s.taken_by as string)).toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [key, rows] of groups) {
    const head = rows[0];
    const meetingId = (head.meeting_id as string) ?? null;
    const jotId = (head.jot_id as string) ?? null;
    if ((meetingId && r.gone.has(`meeting:${meetingId}`)) || (jotId && r.gone.has(`jot:${jotId}`))) continue;
    const jot = jotId ? (db.raw.prepare("SELECT text, item_id FROM jots WHERE id = ?").get(jotId) as Row | undefined) : undefined;
    const said = rows.map((s) => ((s.caption as string) ?? (s.line as string) ?? "").trim()).find(Boolean);
    const title = meetingId ? r.meetingName(meetingId) : clip(((jot?.text as string) ?? "").trim() || said || "Snaps", 120);
    const project = byCount(rows.map((s) => r.projectOfNote(s.note_id as string | null) ?? r.projectOfItem(s.item_id as string | null)));
    out.push({
      artifact: {
        id: `screens:${key}`,
        kind: "screens",
        title,
        projects: project.slice(0, 2),
        makers: makers(rows.map((s) => makerOf({ kind: "person", person: s.taken_by as string }))),
        origin: meetingId ? "Snaps" : undefined,
        href: meetingId ? `/meetings/${meetingId}` : undefined,
      },
      shots: rows.map((s) => ({ url: `/api/snaps/${s.id as string}.${s.ext as string}?v=${s.version as number}`, caption: ((s.caption as string) ?? (s.line as string) ?? null) || null, ts: s.ts as number })),
    });
  }
  return out;
}

function screens(db: DB, roomId: string, r: Reading): Artifact[] {
  return screenSets(db, roomId, r).map(({ artifact, shots }) => ({
    ...artifact,
    ts: shots[shots.length - 1].ts,
    badge: String(shots.length),
    // The newest pictures are the ones worth seeing first.
    preview: { images: shots.slice(-MAX_IMAGES).reverse().map((s) => s.url) },
  }));
}

function docArtifact(d: DocRow, r: Reading): Artifact {
  const project = (d.projectId && r.live.has(d.projectId) ? d.projectId : null) ?? r.projectOfNote(d.noteId);
  return {
    id: `doc:${d.id}`,
    kind: "doc",
    title: d.title,
    ts: d.updatedAt,
    projects: project ? [project] : [],
    makers: makers([makerOf(d.actor, d.by)]),
    badge: d.versions > 1 ? `v${d.versions}` : undefined,
    ref: docRef(d.id),
    preview: { text: plainPreview(d.text, d.title) },
  };
}

/** Everything the space made, newest first. */
export function spaceArtifacts(db: DB, roomId: string): ArtifactList {
  const r = reading(db, roomId);
  const all = [
    ...specs(db, roomId, r),
    ...decks(db, roomId, r),
    ...sketches(db, roomId, r),
    ...recaps(db, roomId, r),
    ...screens(db, roomId, r),
    ...db.roomDocs(roomId).map((d) => docArtifact(d, r)),
  ];
  return { artifacts: all.sort((a, b) => b.ts - a.ts) };
}

/** A to-do's PR, from how it closed or the links of its reports. */
function prLink(db: DB, note: Note): ArtifactLink | null {
  const links = [note.closedBy?.startsWith("pr:") ? note.closedBy.slice(3) : null, ...db.notesUpdates([note.id]).reverse().flatMap((u) => u.links)];
  const link = links.find((l): l is string => !!l && !!prOf(l));
  const pr = link ? prOf(link) : null;
  return link && pr ? { text: `PR #${pr.number}`, note: note.doneAt ? "built from it" : "the work so far", href: link } : null;
}

/** One artifact with the whole of it and what it is tied to, or null when the space has none by that id. */
export function artifactDetail(db: DB, roomId: string, id: string): ArtifactDetail | null {
  const a = spaceArtifacts(db, roomId).artifacts.find((x) => x.id === id);
  if (!a) return null;
  const r = reading(db, roomId);
  const key = id.slice(id.indexOf(":") + 1);
  const links: ArtifactLink[] = [];
  const todo = (noteId: string | null | undefined, note: string) => {
    const n = noteId ? db.notesByIds([noteId])[0] : undefined;
    if (n && !r.gone.has(`todo:${n.id}`)) links.push({ text: clip(n.text, 160), note, taskId: n.id, href: `/ref/action/${n.id}` });
    return n ?? null;
  };
  const meeting = (meetingId: string | null | undefined, note: string) => {
    if (meetingId && !r.gone.has(`meeting:${meetingId}`)) links.push({ text: r.meetingName(meetingId), note, href: `/meetings/${meetingId}` });
  };

  if (a.kind === "spec") {
    const versions = db.planVersions(key);
    const note = todo(key, "the to-do it is on");
    // The design reviews that went through it, with the version each saw.
    const reviewed = db.raw
      .prepare(
        `SELECT DISTINCT v.id, v.started_at, v.meeting_id, s.plan_version FROM review_slides s JOIN reviews v ON v.id = s.review_id
         WHERE v.room_id = ? AND v.kind = 'design' AND v.status = 'done' AND s.note_id = ? ORDER BY v.started_at`,
      )
      .all(roomId, key) as Row[];
    const seen = new Set<string>();
    for (const v of reviewed) {
      if (seen.has(v.id as string)) continue;
      seen.add(v.id as string);
      const at = versions.findIndex((p) => p.id === v.plan_version);
      links.push({ text: v.meeting_id ? r.meetingName(v.meeting_id as string) : "Design review", note: at >= 0 ? `reviewed v${at + 1}` : "reviewed it", href: `/s/${roomId}/design-review/${v.id as string}` });
    }
    // The sketch its draft was written from.
    for (const b of db.brainstorms(roomId, 100))
      if (b.taskId === key || b.sketch?.subjects?.some((s) => s.taskId === key)) links.push({ text: clip(b.prompt, 160), note: "the sketch it came from", href: `/s/${roomId}/brainstorm/${b.id}` });
    const pr = note ? prLink(db, note) : null;
    if (pr) links.push(pr);
    return { ...a, body: versions[versions.length - 1]?.text ?? "", versions, links };
  }

  if (a.kind === "doc") {
    const d = db.getDoc(key);
    if (!d) return null;
    todo(d.noteId, "the to-do it was written for");
    return { ...a, body: d.text, links };
  }

  if (a.kind === "recap") {
    const m = db.raw.prepare("SELECT summary FROM meetings WHERE id = ?").get(key) as Row | undefined;
    // What the meeting made: the other artifacts that came out of it.
    const made = spaceArtifacts(db, roomId).artifacts.filter((x) => x.id !== a.id && x.href && (x.kind === "deck" || x.kind === "sketch") && madeIn(db, x) === key);
    for (const x of made) links.push({ text: x.title, note: x.origin?.toLowerCase(), href: x.href });
    return { ...a, body: ((m?.summary as string) ?? "").trim() || undefined, links };
  }

  if (a.kind === "deck") {
    if (key.startsWith("u-")) return { ...a, links };
    const v = db.getReview(key);
    meeting(v?.meetingId, "the call it ran in");
    const outcome: Record<string, string> = { ship: "ship it", fixes: "needs fixes", not_yet: "not yet", pursue: "pursue", park: "park", drop: "drop" };
    for (const s of db.reviewSlides(key).slice(0, 12)) {
      const n = s.noteId ? db.notesByIds([s.noteId])[0] : undefined;
      links.push({ text: (s.name || s.title).trim(), note: s.outcome ? (outcome[s.outcome] ?? s.outcome) : undefined, ...(n && !r.gone.has(`todo:${n.id}`) ? { taskId: n.id, href: `/ref/action/${n.id}` } : {}) });
    }
    return { ...a, links };
  }

  if (a.kind === "sketch") {
    const b = db.getBrainstorm(key);
    meeting(b?.meetingId, "the call it was drawn in");
    for (const taskId of new Set([b?.taskId, ...(b?.sketch?.subjects ?? []).map((s) => s.taskId)])) todo(taskId, "its draft spec");
    for (const v of db.ideaReviewsOf(key)) if (v.status === "done") links.push({ text: v.title?.trim() || "Idea review", note: "went through its ideas", href: `/s/${roomId}/review/${v.id}` });
    return { ...a, links };
  }

  // Screens.
  const set = screenSets(db, roomId, r).find((s) => s.artifact.id === id);
  if (a.taskId) {
    const note = todo(a.taskId, "the to-do they show");
    const pr = note ? prLink(db, note) : null;
    if (pr) links.push(pr);
  } else if (key.startsWith("m-")) meeting(key.slice(2), "the call they were taken in");
  return { ...a, images: (set?.shots ?? []).map((s) => ({ url: s.url, caption: s.caption })), links };
}

/** The meeting a deck or a sketch came out of. */
function madeIn(db: DB, a: Artifact): string | null {
  const key = a.id.slice(a.id.indexOf(":") + 1);
  if (a.kind === "deck") return key.startsWith("u-") ? null : (db.getReview(key)?.meetingId ?? null);
  if (a.kind === "sketch") return db.getBrainstorm(key)?.meetingId ?? null;
  return null;
}

/** Where an artifact opens in the web app. */
export const artifactUrl = (baseUrl: string, roomId: string, id: string) => `${baseUrl}${artifactHref(roomId, id)}`;

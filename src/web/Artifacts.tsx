// Artifacts: the things a space made that people open again (shared/artifacts.ts). The space's
// Artifacts tab and a project's Artifacts list are the same grid: a card is a small picture of the
// thing, its name and one quiet line. A card opens a panel beside the grid with the whole of it and
// what it is tied to. On a phone the grid is one-line rows.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ARTIFACT_KINDS, ARTIFACT_NAME, type Artifact, type ArtifactDetail, type ArtifactKind, type ArtifactLink, filterArtifacts, makersLine, makersOf } from "../shared/artifacts.ts";
import { CopyForAgent } from "./CopyForAgent.tsx";
import { Markdown } from "./Markdown.tsx";
import { api } from "./api.ts";
import { CloseIcon } from "./icons.tsx";
import { usePhone } from "./phone.ts";
import { fmtDay, fmtTime } from "./util.ts";

// The board is a heavy picture (maps and diagrams): it loads when a sketch is first shown.
const SketchPicture = lazy(() => import("./SketchPicture.tsx"));
/** The space and the sketch behind a sketch artifact, from the page it opens. */
const sketchAt = (a: Artifact) => /^\/s\/([^/]+)\/brainstorm\/([^/?]+)/.exec(a.href ?? "");

/** How often the list is read again while it is on screen. */
const REFRESH_MS = 60_000;
const DAY = 86_400_000;

/** The space's artifacts, read once and again every so often while the page is in view. */
export function useArtifacts(roomId: string): { artifacts: Artifact[] | null; error: string; reload: () => void } {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api.artifacts(roomId).then(
      (l) => {
        setArtifacts(l.artifacts);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  }, [roomId]);
  useEffect(() => {
    setArtifacts(null);
    reload();
    const t = setInterval(() => document.visibilityState === "visible" && reload(), REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);
  return { artifacts, error, reload };
}

const dayStart = (ts: number) => new Date(ts).setHours(0, 0, 0, 0);
const WEEKDAY = new Intl.DateTimeFormat([], { weekday: "short" });
/** "Today", "Yesterday", "Wed" within the week, then "Nov 11". */
export function whenLabel(ts: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(ts)) / DAY);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? WEEKDAY.format(ts) : fmtDay(ts);
}

const Dot = ({ kind }: { kind: ArtifactKind }) => <i className={`af-dot k-${kind}`} aria-hidden />;

/** What a sketch's card shows until its own picture is drawn: how it is drawn. */
function SketchGlyph({ drawn }: { drawn: "map" | "diagram" }) {
  return drawn === "diagram" ? (
    <svg className="af-glyph" viewBox="0 0 260 128" aria-hidden>
      <g className="af-glyph-lines"><path d="M64 84h36M150 84h40M125 70V56" /></g>
      <g className="af-glyph-boxes"><rect x="20" y="70" width="44" height="26" rx="5" /><rect x="100" y="70" width="50" height="26" rx="5" /><rect x="190" y="70" width="48" height="26" rx="5" /><rect x="100" y="34" width="50" height="22" rx="11" /></g>
    </svg>
  ) : (
    <svg className="af-glyph" viewBox="0 0 260 128" aria-hidden>
      <g className="af-glyph-lines"><path d="M130 76 70 50M130 76l62-24M130 76l-50 34M130 76l58 30M70 50 36 40M192 52l34-10" /></g>
      <circle className="af-glyph-centre" cx="130" cy="76" r="13" />
      <g className="af-glyph-boxes"><circle cx="70" cy="50" r="8" /><circle cx="192" cy="52" r="8" /><circle cx="80" cy="110" r="7" /><circle cx="188" cy="106" r="7" /><circle cx="36" cy="40" r="5" /><circle cx="226" cy="42" r="5" /></g>
    </svg>
  );
}

/** The small picture of an artifact: its own text, pictures or slides where it has them. */
function Thumb({ a, small }: { a: Artifact; small?: boolean }) {
  const p = a.preview;
  return (
    <span className={`af-thumb k-${a.kind}`}>
      {a.kind === "sketch" ? (
        (() => {
          const glyph = <SketchGlyph drawn={p.drawn ?? "map"} />;
          const at = sketchAt(a);
          return at ? <Suspense fallback={glyph}><SketchPicture roomId={at[1]} id={at[2]} small fallback={glyph} /></Suspense> : glyph;
        })()
      ) : a.kind === "deck" ? (
        <span className="af-slide">
          {(p.slides?.length ? p.slides : [a.title]).slice(0, small ? 1 : 4).map((s, i) => (
            <span key={i} className={i === 0 ? "af-slide-title" : "af-slide-line"}>{s}</span>
          ))}
        </span>
      ) : (
        <span className="af-text">
          {p.text && <span className="af-text-body">{p.text}</span>}
        </span>
      )}
      {!small && (
        <>
          <span className="af-kind"><Dot kind={a.kind} />{ARTIFACT_NAME[a.kind].one}</span>
          {a.badge && <span className="af-badge">{a.badge}</span>}
        </>
      )}
    </span>
  );
}

/** The quiet line under a name: its project, who or what made it, and when. */
function metaOf(a: Artifact, projectName: (id: string) => string | undefined, inProject: boolean): string[] {
  const named = a.projects.map(projectName).filter((n): n is string => !!n);
  const project = inProject ? null : named.length > 1 ? `${named.length} projects` : (named[0] ?? null);
  const made = a.origin && a.makers.every((m) => m.key === "stand") ? a.origin : makersLine(a.makers) || a.origin || null;
  return [project, made, whenLabel(a.ts)].filter((x): x is string => !!x);
}

export function ArtifactsView(props: {
  artifacts: Artifact[] | null;
  error?: string;
  /** Project names by id, for the line under each card. */
  projects: Map<string, string>;
  /** Only this project's ("none": Unassigned). Its cards leave the project's name out. */
  project?: string;
  /** The whole space, under a header per project: the projects in order, "none" for Unassigned last. */
  groups?: Array<{ id: string; name: string }>;
  /** A group's header was pressed: its project opens. */
  onGroup?: (id: string) => void;
  /** Only what this meeting made, as plain rows with no filters. */
  meeting?: string;
  /** The artifact that is open in the panel. */
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const phone = usePhone() || !!props.meeting;
  const [kind, setKind] = useState<ArtifactKind | "">("");
  const [maker, setMaker] = useState("");
  const scoped = useMemo(() => filterArtifacts(props.artifacts ?? [], { project: props.project, meeting: props.meeting }), [props.artifacts, props.project, props.meeting]);
  const makers = useMemo(() => makersOf(scoped), [scoped]);
  const byMaker = useMemo(() => filterArtifacts(scoped, { maker }), [scoped, maker]);
  const counts = useMemo(() => {
    const n = new Map<ArtifactKind, number>();
    for (const a of byMaker) n.set(a.kind, (n.get(a.kind) ?? 0) + 1);
    return n;
  }, [byMaker]);
  // A filter whose last artifact went away falls back to everything.
  useEffect(() => {
    if (kind && props.artifacts && !counts.get(kind)) setKind("");
  }, [kind, counts, props.artifacts]);
  useEffect(() => {
    if (maker && props.artifacts && !makers.some((m) => m.key === maker)) setMaker("");
  }, [maker, makers, props.artifacts]);
  const shown = kind ? byMaker.filter((a) => a.kind === kind) : byMaker;
  const kinds = ARTIFACT_KINDS.filter((k) => counts.get(k));
  const projectName = (id: string) => props.projects.get(id);

  if (props.error && !props.artifacts) return <p className="error">{props.error}</p>;
  if (!props.artifacts) return null;
  if (!scoped.length)
    return (
      <p className="sh-card-empty">
        {props.project ? "Nothing made in this project yet." : "Nothing here yet. Specs, docs, decks and sketches land here as the space makes them."}
      </p>
    );
  const cards = (items: Artifact[], inProject: boolean) => (
      <ul className={phone ? "af-rows" : "af-grid"}>
        {items.map((a) => {
          const meta = metaOf(a, projectName, inProject);
          return (
            <li key={a.id}>
              <button type="button" className={props.selected === a.id ? "af-card on" : "af-card"} aria-current={props.selected === a.id ? "true" : undefined} onClick={() => props.onSelect(a.id)}>
                <Thumb a={a} small={phone} />
                <span className="af-words">
                  <span className="af-title" dir="auto" title={a.title}>{a.title}</span>
                  <span className="af-meta">
                    {phone && <><Dot kind={a.kind} />{ARTIFACT_NAME[a.kind].one} · </>}
                    {(phone ? meta.filter((_, i) => i !== 1 || meta.length < 3) : meta).join(" · ")}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
  );
  // By project, in the space's order, then what is in none. A project with nothing shown is left out.
  const groups = props.groups
    ?.map((g) => ({ ...g, items: shown.filter((x) => (g.id === "none" ? !x.projects.length || !props.groups!.some((o) => o.id === x.projects[0]) : x.projects[0] === g.id)) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="af">
      {!props.meeting && (kinds.length > 1 || makers.length > 1) && (
        <div className="af-bar">
          <div className="sh-kinds af-kinds" role="group" aria-label="Which kind">
            <button type="button" className={kind === "" ? "rp-pill on" : "rp-pill"} aria-pressed={kind === ""} onClick={() => setKind("")}>All</button>
            {kinds.map((k) => (
              <button key={k} type="button" className={kind === k ? "rp-pill on" : "rp-pill"} aria-pressed={kind === k} onClick={() => setKind(kind === k ? "" : k)}>
                <Dot kind={k} />
                {ARTIFACT_NAME[k].many}
                {!phone && <span className="muted">{counts.get(k)}</span>}
              </button>
            ))}
          </div>
          {makers.length > 1 && !phone && (
            <label className="af-by">
              <span className="sr-only">Made by</span>
              <select value={maker} onChange={(e) => setMaker(e.target.value)}>
                <option value="">Made by anyone</option>
                {makers.map((m) => (
                  <option key={m.key} value={m.key}>{m.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {groups
        ? groups.map((g) => (
            <section key={g.id} className="af-group" aria-label={g.name}>
              <h3>
                <button type="button" className="af-group-name" onClick={() => props.onGroup?.(g.id)}>
                  <span dir="auto">{g.name}</span>
                  <span className="muted">{g.items.length}</span>
                </button>
              </h3>
              {cards(g.items, true)}
            </section>
          ))
        : cards(shown, !!props.project)}
    </div>
  );
}

/** What one meeting made, in a pop-up over the list of meetings: a row each, and a row opens it. */
export function MeetingMade(props: { title: string; meeting: string; artifacts: Artifact[] | null; projects: Map<string, string>; onSelect: (id: string) => void; onClose: () => void }) {
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog af-made" role="dialog" aria-modal="true" aria-label={`Made in ${props.title}`}>
        <header>
          <h2 dir="auto">{props.title}</h2>
          <button className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <ArtifactsView artifacts={props.artifacts} projects={props.projects} meeting={props.meeting} selected={null} onSelect={props.onSelect} />
      </div>
    </div>
  );
}

/** Copies a doc's reference as a line an agent can act on. */
function CopyDocRef({ docRef, title }: { docRef: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard?.writeText(`Read this Stand doc with list_artifacts (ref: ${docRef}) and work from it: "${title}"`).then(() => {
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1800);
    }, () => {});
  };
  return (
    <button type="button" className="af-btn" onClick={copy} title="Copy a line with this doc's Stand reference, to paste into Claude Code, Cursor or Codex">
      {copied ? "Copied" : "Copy for agent"}
    </button>
  );
}

function LinkRow({ link, onOpenTask }: { link: ArtifactLink; onOpenTask: (id: string) => void }) {
  const body = (
    <>
      <span className="af-link-text" dir="auto">{link.text}</span>
      {link.note && <span className="af-link-note">{link.note}</span>}
    </>
  );
  if (link.taskId) {
    const id = link.taskId;
    return (
      <a
        className="af-link"
        href={link.href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onOpenTask(id);
        }}
      >
        {body}
      </a>
    );
  }
  if (link.href?.startsWith("http")) return <a className="af-link" href={link.href} target="_blank" rel="noreferrer">{body}</a>;
  if (link.href) return <Link className="af-link" to={link.href}>{body}</Link>;
  return <span className="af-link plain">{body}</span>;
}

/** One artifact, opened beside the grid: the whole of it, and what it is tied to. */
export function ArtifactPanel(props: {
  roomId: string;
  id: string;
  /** What the list already knows of it, shown while the rest loads. */
  known?: Artifact;
  projects: Map<string, string>;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onProject: (id: string) => void;
  /** The projects it can move to, in the space's order. */
  moveTo: Array<{ id: string; name: string }>;
  /** It was moved: the list is read again. */
  onMoved: () => void;
}) {
  const { roomId, id, onClose } = props;
  const [movedTo, setMovedTo] = useState<string | null | undefined>(undefined);
  const move = (to: string | null) => {
    setMovedTo(to);
    api.moveArtifact(roomId, id, to).then(props.onMoved, () => setMovedTo(undefined));
  };
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [queued, setQueued] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setDetail(null);
    setError("");
    setVersion(null);
    setQueued(null);
    api.artifact(roomId, id).then((d) => {
      if (!live) return;
      setDetail(d);
      // Whether a spec already waits on the next design review.
      if (d.kind === "spec" && d.taskId) api.designReviewState(d.taskId).then((s) => live && setQueued(s.queued), () => {});
    }, (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [roomId, id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const a: Artifact | ArtifactDetail | undefined = detail ?? props.known;
  const versions = detail?.versions ?? [];
  const at = version ?? versions.length - 1;
  const whole = versions.length ? versions[at]?.text : detail?.body;
  // The panel's title is the text's own first heading: it isn't said twice.
  const body = whole && a ? whole.replace(/^\s*#{1,3}\s+(.+?)\s*#*\s*(\n|$)/, (line, h: string) => (h.replace(/[*_`]/g, "").trim().toLowerCase() === a.title.toLowerCase() ? "" : line)) : whole;
  const taskId = a?.taskId;
  const bring = () => {
    if (!taskId) return;
    setQueued(true);
    api.requestDesignReview(taskId).then((s) => setQueued(s.queued), () => setQueued(false));
  };

  return (
    <aside className="task-drawer af-panel" role="complementary" aria-label="Artifact">
      <div className="td-head">
        <span className="td-kind af-panel-kind">
          {a && (
            <>
              <Dot kind={a.kind} />
              {ARTIFACT_NAME[a.kind].one}
              {versions.length > 1 ? (
                <label>
                  <span className="sr-only">Version</span>
                  <select value={at} onChange={(e) => setVersion(Number(e.target.value))}>
                    {versions.map((v, i) => (
                      <option key={v.id} value={i}>{`v${i + 1} of ${versions.length}`}</option>
                    ))}
                  </select>
                </label>
              ) : (
                a.badge && <span>· {a.badge}</span>
              )}
              <span>· {whenLabel(versions[at]?.ts ?? a.ts)}, {fmtTime(versions[at]?.ts ?? a.ts)}</span>
            </>
          )}
        </span>
        <button className="icon-btn td-close" aria-label="Close" title="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="td-body">
        {error && <p className="error">{error}</p>}
        {a && (
          <>
            <h2 className="td-title" dir="auto">{a.title}</h2>
            <div className="af-chips">
              {a.kind === "spec" ? (
                // A spec is in its to-do's project: the pill goes there.
                a.projects.map((p) => props.projects.get(p) && (
                  <button key={p} type="button" className="rp-pill" onClick={() => props.onProject(p)}>{props.projects.get(p)}</button>
                ))
              ) : (
                props.moveTo.length > 0 && (
                  <label className="rp-pill af-move">
                    <span className="sr-only">Project</span>
                    <select value={(movedTo === undefined ? a.projects[0] : movedTo) ?? ""} onChange={(e) => move(e.target.value || null)}>
                      <option value="">Unassigned</option>
                      {props.moveTo.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </label>
                )
              )}
              {a.makers.map((m) => (
                <span key={m.key} className="rp-pill af-maker">{m.name}</span>
              ))}
              {a.origin && !a.makers.length && <span className="rp-pill af-maker">{a.origin}</span>}
            </div>
            {body ? (
              <div className="af-doc"><Markdown text={body} /></div>
            ) : (
              a.kind === "sketch" && sketchAt(a) ? (
                <div className="af-sketch-open">
                  <Suspense fallback={null}><SketchPicture roomId={sketchAt(a)![1]} id={sketchAt(a)![2]} fallback={null} /></Suspense>
                </div>
              ) : (
                (a.kind === "sketch" || a.kind === "deck") && <div className="af-doc af-doc-thumb"><Thumb a={a} /></div>
              )
            )}
            {!!detail?.images?.length && (
              <>
                <h3 className="af-links-title">Screenshots</h3>
                <div className="af-shots">
                  {detail.images.map((im, i) => (
                    <a key={i} href={im.url} target="_blank" rel="noreferrer" title={im.caption ?? undefined}>
                      <img src={im.url} alt={im.caption ?? ""} loading="lazy" />
                      {im.caption && <span>{im.caption}</span>}
                    </a>
                  ))}
                </div>
              </>
            )}
            <div className="af-actions">
              {a.href ? (
                <Link className="af-btn primary" to={a.href}>Open</Link>
              ) : (
                taskId && <button type="button" className="af-btn primary" onClick={() => props.onOpenTask(taskId)}>Open the to-do</button>
              )}
              {a.kind === "spec" && taskId && <CopyForAgent kind="action" id={taskId} label />}
              {a.kind === "doc" && a.ref && <CopyDocRef docRef={a.ref} title={a.title} />}
              {a.kind === "spec" && taskId && queued !== null && (
                <button type="button" className="af-btn" disabled={queued} onClick={bring}>{queued ? "On the next design review" : "Bring to a review"}</button>
              )}
            </div>
            {detail && detail.links.length > 0 && (
              <section className="af-links" aria-label="Where it came up">
                <h3>Where it came up</h3>
                {detail.links.map((l, i) => (
                  <LinkRow key={i} link={l} onOpenTask={props.onOpenTask} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

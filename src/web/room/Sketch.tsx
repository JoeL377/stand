// The sketch: the one board a call draws on (server/sketch.ts). It holds every subject the talk was
// on, each drawn as a map (BrainMap) or as a diagram (DesignBoard). The subject the talk is on fills
// the canvas; a pill per subject brings another one up. Each subject
// has a chip saying how it is drawn, and picking the other way redraws just that subject. Nobody
// drags or draws here: what is wrong is fixed by a click on it, or by telling Stand.

import { BrainWords } from "./BrainWords.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useUpdated } from "./written.tsx";
import { ChevronDown, Share2, Workflow } from "lucide-react";
import {
  UNTITLED_DESIGN,
  subjectNodes,
  type BrainCaught,
  type BrainNode,
  type BrainstormView,
  type DesignBox,
  type DesignDiagram,
  type SketchStyle,
  type SketchSubject,
} from "../../shared/protocol.ts";
import { BrainMap, Face, KIND, KINDS } from "./BrainMap.tsx";
import { DesignBoard } from "./DesignBoard.tsx";

/** What people in the call can do to a sketch. Left out where it is only read (its page). */
export interface SketchActs {
  style: (subject: string, style: SketchStyle) => void;
  edit: (
    subject: string,
    id: string,
    op: "rename" | "remove" | "move",
    arg?: { label?: string; to?: string },
  ) => void;
  undo: () => void;
  offer: (take: boolean) => void;
  keep: (subject: string, id: string) => void;
}

const EMPTY: DesignDiagram = { boxes: [], arrows: [] };
const STYLE: Record<
  SketchStyle,
  { label: string; about: string; Icon: typeof Share2 }
> = {
  map: { label: "Map", about: "Ideas around one question", Icon: Share2 },
  diagram: {
    label: "Diagram",
    about: "Steps and parts, and how they connect",
    Icon: Workflow,
  },
};

/** A sketch's subjects, for one from before sketches too (the server sends them for every one now). */
export function subjectsOf(b: BrainstormView): SketchSubject[] {
  const all: SketchSubject[] = b.subjects?.length
    ? b.subjects
    : [
        {
          id: "s0",
          title: b.prompt,
          style: b.design ? "diagram" : "map",
          ...(b.design ? { diagram: b.design } : {}),
        },
      ];
  // One opened with nothing typed has no name until the talk gives it one.
  return all.map((s) =>
    s.title === UNTITLED_DESIGN ? { ...s, title: UNNAMED } : s,
  );
}
const UNNAMED = "This call";

const mapNodes = (
  b: BrainstormView,
  s: SketchSubject,
  i: number,
): BrainNode[] =>
  subjectNodes(b.nodes, i === 0 ? { title: b.prompt } : s, i === 0).map(
    ({ cluster: _c, ...n }) => n,
  );

/** How much a subject holds as it is drawn, and what that is called. */
export function subjectCount(
  b: BrainstormView,
  s: SketchSubject,
  i: number,
): { n: number; word: string } {
  if (s.style === "diagram") {
    const n = s.diagram?.boxes.length ?? 0;
    return { n, word: n === 1 ? "part" : "parts" };
  }
  const n = mapNodes(b, s, i).filter((x) => x.parent).length;
  return { n, word: n === 1 ? "idea" : "ideas" };
}

/** The subjects worth showing: one that opened with nothing typed and still holds nothing steps aside once the talk has named others. */
export function shownSubjects(
  b: BrainstormView,
): Array<{ s: SketchSubject; i: number }> {
  const all = subjectsOf(b).map((s, i) => ({ s, i }));
  const real = all.filter(
    ({ s, i }) =>
      !(i === 0 && s.title === UNNAMED && subjectCount(b, s, i).n === 0),
  );
  return real.length ? real : all.slice(0, 1);
}

/** One subject as the brainstorm its own component draws: its title in the middle, its circles or its diagram. */
function viewOf(
  b: BrainstormView,
  s: SketchSubject,
  i: number,
): BrainstormView {
  return {
    ...b,
    prompt: s.title,
    nodes: mapNodes(b, s, i),
    design: s.diagram ?? EMPTY,
    context: i === 0 ? b.context : undefined,
    subjects: undefined,
  };
}

function caughtOf(
  b: BrainstormView,
  s: SketchSubject,
  i: number,
): BrainCaught[] {
  return s.style === "diagram"
    ? (s.diagram?.boxes ?? []).flatMap((x) => x.caught)
    : mapNodes(b, s, i).flatMap((n) => n.caught);
}

/** How a sketch is read: drawn, as an outline, or as the words the talk kept coming back to. */
export type SketchAs = "picture" | "list" | "words";

export function StyleChip(props: {
  subject: SketchSubject;
  onPick?: (style: SketchStyle) => void;
  /** A phone: the mark alone. */ compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, label } = STYLE[props.subject.style];
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    return () => (
      window.removeEventListener("click", close),
      window.removeEventListener("keydown", key)
    );
  }, [open]);
  if (!props.onPick) {
    return (
      <span
        className={`sk-chip plain${props.compact ? " compact" : ""}`}
        title={
          props.compact
            ? `Drawn as a ${label.toLowerCase()}`
            : STYLE[props.subject.style].about
        }
        aria-label={`Drawn as a ${label.toLowerCase()}`}
      >
        <Icon size={13} aria-hidden /> {!props.compact && label}
      </span>
    );
  }
  return (
    <span className="sk-chip-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`sk-chip${open ? " on" : ""}${props.compact ? " compact" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="How this subject is drawn"
        aria-label={`Drawn as a ${label.toLowerCase()}. Change`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={13} aria-hidden /> {!props.compact && label}{" "}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <span className="sk-menu" role="menu">
          {(["diagram", "map"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="menuitemradio"
              aria-checked={props.subject.style === k}
              className={props.subject.style === k ? "on" : ""}
              onClick={() => (
                setOpen(false),
                props.subject.style !== k && props.onPick!(k)
              )}
            >
              <strong>{STYLE[k].label}</strong>
              <span className="muted">{STYLE[k].about}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** Nothing on a subject yet: say so, and show the last thing heard so people can see Stand follows. */
function Listening(props: {
  b: BrainstormView;
  heard?: { speaker: string; text: string } | null;
}) {
  const { b } = props;
  if (b.status !== "live")
    return (
      <div className="sk-empty">
        <p className="muted">Nothing was drawn for this one.</p>
      </div>
    );
  return (
    <div className="sk-empty">
      {b.heard === "failed" ? (
        <>
          <p className="sk-empty-head">
            Stand couldn't read the talk just now.
          </p>
          <p className="muted">It tries again on the next thing said.</p>
        </>
      ) : (
        <>
          <i className={`sk-pulse${b.busy ? " busy" : ""}`} aria-hidden />
          <p className="sk-empty-head">
            {b.heard === "nothing"
              ? "Listening. Nothing drawable heard yet."
              : "Listening."}
          </p>
          <p className="muted">
            Stand draws once someone names ideas, steps or parts.
          </p>
        </>
      )}
      {props.heard && (
        <p className="sk-heard" dir="auto">
          <Face name={props.heard.speaker} />
          <span>
            {props.heard.speaker.split(" ")[0]} · {props.heard.text}
          </span>
        </p>
      )}
    </div>
  );
}

export function SketchBoard(props: {
  brainstorm: BrainstormView;
  acts?: SketchActs;
  phone?: boolean;
  as: SketchAs;
  /** The subject picked on this screen; null follows the talk. */
  subject: string | null;
  onSubject: (id: string | null) => void;
  /** The last line said in the call, for the listening state. */
  heard?: { speaker: string; text: string } | null;
  /** What sits in the sketch's one row before and after its own controls: the board's pills and switches. */
  lead?: ReactNode;
  tail?: ReactNode;
  /** The sketch's own page, offered in the subject's menu. */
  pageHref?: string;
  className?: string;
}) {
  const b = props.brainstorm;
  const live = b.status === "live";
  const shown = shownSubjects(b);
  const liveId = live
    ? (shown.find((x) => x.s.id === b.liveSubject)?.s.id ?? shown[0].s.id)
    : null;
  const picked =
    props.subject && shown.some((x) => x.s.id === props.subject)
      ? props.subject
      : null;
  const mainId =
    picked ??
    liveId ??
    (shown.find((x) => subjectCount(b, x.s, x.i).n > 0) ?? shown[0]).s.id;
  const main = shown.find((x) => x.s.id === mainId)!;
  const acts = live ? props.acts : undefined;

  // To-dos, decisions and open questions caught on anything on the sketch: one set of counts, and one filter for all of it.
  const [only, setOnly] = useState<BrainCaught["kind"] | null>(null);
  const all = shown.flatMap(({ s, i }) => caughtOf(b, s, i));
  const totals = KINDS.map((k) => ({
    ...k,
    n: new Set(all.filter((c) => c.kind === k.kind).map((c) => c.id)).size,
  })).filter((k) => k.n > 0);
  useEffect(() => {
    if (only && !totals.some((t) => t.kind === only)) setOnly(null);
  }, [only, totals.length]);

  // Why Stand drew a subject the talk moved to as a diagram: said once, for a little while.
  const [told, setTold] = useState<string[]>([]);
  const why = live && main.s.why && !told.includes(main.s.id) ? main.s : null;
  useEffect(() => {
    if (!why) return;
    const t = setTimeout(() => setTold((x) => [...x, why.id]), 20_000);
    return () => clearTimeout(t);
  }, [why?.id]);
  // When Stand adds to the subject on screen, the row says so and the sheet's edge lights once.
  const mainIds = main.s.style === "diagram" ? (main.s.diagram?.boxes ?? []).map((x) => x.id) : viewOf(b, main.s, main.i).nodes.map((n) => n.id);
  const updatedAt = useUpdated(live ? mainIds : [], main.s.id);
  // The last change can be taken back until it goes stale.
  const [, tick] = useState(0);
  const undo =
    live && b.undo && Date.now() - b.undo.at < 30_000 ? b.undo : null;
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(
      () => tick((n) => n + 1),
      Math.max(500, 30_000 - (Date.now() - undo.at)),
    );
    return () => clearTimeout(t);
  }, [undo?.at]);
  const offer =
    live && b.offer
      ? (shown.find((x) => x.s.id === b.offer!.subject) ?? null)
      : null;

  // One row holds everything: the board's own pills (lead), the subject on screen with its menu,
  // the counts, and the board's switches (tail).
  const kinds = totals.length > 0 && (
    <span className="sk-kinds" role="group" aria-label="Show one kind">
      {totals.map(({ kind, Icon, many, n }) => (
        <button
          key={kind}
          type="button"
          className={`brain-kind-pill ${kind}${only === kind ? " on" : ""}`}
          aria-pressed={only === kind}
          title={many}
          onClick={() => setOnly(only === kind ? null : kind)}
        >
          <Icon size={13} />
          <span>{n}</span>
        </button>
      ))}
    </span>
  );
  // In a call the list reads one subject at a time too, the one the pill names; a page lists them all.
  const inCall = !!(props.lead || props.tail);
  const menu = props.as !== "words" && (props.as === "picture" || inCall) && (
    <SubjectMenu
      shown={shown.map((x) => ({ ...x, n: subjectCount(b, x.s, x.i).n }))}
      mainId={mainId}
      liveId={liveId}
      onSubject={(id) => props.onSubject(id === liveId ? null : id)}
      onStyle={acts ? (style) => acts.style(main.s.id, style) : undefined}
      onRename={
        acts
          ? (label) => acts.edit(main.s.id, main.s.id, "rename", { label })
          : undefined
      }
      pageHref={props.pageHref}
    />
  );
  const pills = (props.lead || props.tail || menu || kinds) && (
    <div className="view-bar sk-bar">
      {props.lead}
      {menu}
      <span className="rp-grow" />
      {updatedAt && (
        <span key={updatedAt} className="topic-updating on done sk-updated" role="status">
          <span className="agent-mark" aria-hidden>
            ✦
          </span>{" "}
          Updated
        </span>
      )}
      {kinds}
      {props.tail}
    </div>
  );

  const dock = (offer || undo || why) && (
    <div className="sk-dock" role="status">
      {offer ? (
        <div className="nudge sk-note">
          <button
            type="button"
            className="primary next-do"
            disabled={!acts}
            onClick={() => acts?.offer(true)}
          >
            Redraw
          </button>
          <span className="agent-mark" aria-hidden>
            ✦
          </span>
          <span className="nudge-text">
            {b.offer!.style === "diagram"
              ? "This is turning into steps. Redraw "
              : "This sounds like ideas. Redraw "}
            <strong dir="auto">{offer.s.title}</strong> as a {b.offer!.style}?
          </span>
          <button
            type="button"
            className="link muted"
            aria-label="No thanks"
            disabled={!acts}
            onClick={() => acts?.offer(false)}
          >
            ✕
          </button>
        </div>
      ) : undo ? (
        <div className="nudge sk-note">
          <span className="agent-mark" aria-hidden>
            ✦
          </span>
          <span className="nudge-text">
            {undo.by ? `${undo.by}: ` : ""}
            {undo.text}
          </span>
          <button
            type="button"
            className="link"
            disabled={!acts}
            onClick={() => acts?.undo()}
          >
            Undo
          </button>
        </div>
      ) : (
        why && (
          <div className="nudge sk-note">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>
            <span className="nudge-text">New subject, drawn as a diagram.</span>
            <button
              type="button"
              className="link"
              disabled={!acts}
              onClick={() => (
                acts?.style(why.id, "map"),
                setTold((x) => [...x, why.id])
              )}
            >
              Redraw as map
            </button>
            <button
              type="button"
              className="link muted"
              aria-label="Close"
              onClick={() => setTold((x) => [...x, why.id])}
            >
              ✕
            </button>
          </div>
        )
      )}
    </div>
  );

  if (props.as === "words") {
    return (
      <div className={`sketch as-words${props.phone ? " phone" : ""}${props.className ? ` ${props.className}` : ""}`}>
        {pills}
        <BrainWords brainstorm={b} />
        {dock}
      </div>
    );
  }
  if (props.as === "list") {
    return (
      <div
        className={`sketch as-list${props.phone ? " phone" : ""}${props.className ? ` ${props.className}` : ""}`}
      >
        {pills}
        <SketchList
          b={b}
          shown={inCall ? [main] : shown}
          plain={inCall}
          liveId={liveId}
          only={only}
          acts={acts}
          heard={props.heard}
        />
        {dock}
      </div>
    );
  }

  const draw = ({ s, i }: { s: SketchSubject; i: number }) => {
    const v = viewOf(b, s, i);
    if (
      subjectCount(b, s, i).n === 0 &&
      (s.style === "diagram" || !v.nodes.length)
    )
      return <Listening b={b} heard={props.heard} />;
    if (s.style === "diagram")
      return (
        <DesignBoard
          key={`${s.id}:d`}
          brainstorm={v}
          bare
          only={only}
          onKeep={acts ? (id) => acts.keep(s.id, id) : undefined}
          onDrop={acts ? (id) => acts.edit(s.id, id, "remove") : undefined}
          onRename={
            acts
              ? (id, label) => acts.edit(s.id, id, "rename", { label })
              : undefined
          }
        />
      );
    return (
      <BrainMap
        key={`${s.id}:m`}
        brainstorm={v}
        only={only}
        onRemove={acts ? (id) => acts.edit(s.id, id, "remove") : undefined}
        onRename={
          acts
            ? (id, label) => acts.edit(s.id, id, "rename", { label })
            : undefined
        }
        onMove={
          acts ? (id, to) => acts.edit(s.id, id, "move", { to }) : undefined
        }
        moveTo={shown
          .filter((x) => x.s.id !== s.id && x.s.style === "map")
          .map((x) => ({ id: x.s.id, label: x.s.title }))}
      />
    );
  };

  return (
    <div
      className={`sketch${props.phone ? " phone" : ""}${props.className ? ` ${props.className}` : ""}`}
    >
      {pills}
      <div className="sk-body">
        <section className="sk-main" aria-label={main.s.title}>
          <div className="sk-canvas">
            {draw(main)}
            {updatedAt && <span key={updatedAt} className="topic-flash" aria-hidden />}
          </div>
        </section>
      </div>
      {dock}
    </div>
  );
}

/** The subject on screen, as one pill. Its menu holds the other subjects, the other way to draw
 *  this one, its name, and the sketch's page. */
function SubjectMenu(props: {
  shown: Array<{ s: SketchSubject; n: number }>;
  mainId: string;
  liveId: string | null;
  onSubject: (id: string) => void;
  onStyle?: (style: SketchStyle) => void;
  onRename?: (label: string) => void;
  pageHref?: string;
}) {
  const main = props.shown.find((x) => x.s.id === props.mainId)!;
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [text, setText] = useState(main.s.title);
  useEffect(
    () => (setNaming(false), setText(main.s.title)),
    [main.s.id, main.s.title],
  );
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    return () => (
      window.removeEventListener("click", close),
      window.removeEventListener("keydown", key)
    );
  }, [open]);
  const { Icon } = STYLE[main.s.style];
  const other: SketchStyle = main.s.style === "map" ? "diagram" : "map";
  const many = props.shown.length > 1;
  const has = many || !!props.onStyle || !!props.onRename || !!props.pageHref;
  // The talk moved to another subject than the one on screen: the pill says so with a dot.
  const elsewhere = many && props.liveId && props.liveId !== props.mainId;
  if (naming) {
    const save = () => {
      const t = text.trim();
      if (t && t !== main.s.title) props.onRename!(t);
      setNaming(false);
    };
    return (
      <form
        className="sk-title-edit"
        onSubmit={(e) => (e.preventDefault(), save())}
      >
        <input
          autoFocus
          value={text}
          maxLength={80}
          aria-label="Subject name"
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
        />
      </form>
    );
  }
  return (
    <span
      className="sk-chip-wrap sk-subject-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`rp-pill sk-subject${open ? " on" : ""}`}
        disabled={!has}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Drawn as a ${STYLE[main.s.style].label.toLowerCase()}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={13} aria-hidden />
        <span dir="auto">{main.s.title}</span>
        {many && (
          <span className="count">
            {props.shown.findIndex((x) => x.s.id === props.mainId) + 1}/
            {props.shown.length}
          </span>
        )}
        {elsewhere && (
          <i
            className="sk-live"
            title="The talk has moved to another subject"
            aria-label="The talk has moved to another subject"
          />
        )}
        {has && <ChevronDown size={12} aria-hidden />}
      </button>
      {open && (
        <span className="sk-menu" role="menu">
          {many &&
            props.shown.map(({ s, n }) => {
              const I = STYLE[s.style].Icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.id === props.mainId}
                  className={`sk-menu-row${s.id === props.mainId ? " on" : ""}`}
                  onClick={() => (setOpen(false), props.onSubject(s.id))}
                >
                  <I size={13} aria-hidden />
                  <span className="sk-menu-name" dir="auto">
                    {s.title}
                  </span>
                  {s.id === props.liveId && (
                    <i
                      className="sk-live"
                      title="The talk is on this now"
                      aria-label="The talk is on this now"
                    />
                  )}
                  {n > 0 && <span className="muted">{n}</span>}
                </button>
              );
            })}
          {many && (props.onStyle || props.onRename || props.pageHref) && (
            <i className="sk-menu-line" aria-hidden />
          )}
          {props.onStyle && (
            <button
              type="button"
              role="menuitem"
              className="sk-menu-row"
              onClick={() => (setOpen(false), props.onStyle!(other))}
            >
              {(() => {
                const O = STYLE[other].Icon;
                return <O size={13} aria-hidden />;
              })()}
              <span className="sk-menu-name">Redraw as a {other}</span>
            </button>
          )}
          {props.onRename && (
            <button
              type="button"
              role="menuitem"
              className="sk-menu-row"
              onClick={() => (setOpen(false), setNaming(true))}
            >
              <span className="sk-menu-name">Rename</span>
            </button>
          )}
          {props.pageHref && (
            <a
              role="menuitem"
              className="sk-menu-row"
              href={props.pageHref}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
            >
              <span className="sk-menu-name">Open its page ↗</span>
            </a>
          )}
        </span>
      )}
    </span>
  );
}

/** A diagram's boxes in the order its arrows run, so a flow reads top to bottom as a numbered list. */
export function inOrder(d: DesignDiagram): DesignBox[] {
  const left = new Map(
    d.boxes.map((x) => [
      x.id,
      d.arrows.filter((a) => a.to === x.id && a.from !== x.id).length,
    ]),
  );
  const out: DesignBox[] = [];
  const rest = [...d.boxes];
  while (rest.length) {
    // The next box nothing still points at; a loop is broken at its earliest box.
    let k = rest.findIndex((x) => (left.get(x.id) ?? 0) <= 0);
    if (k < 0) k = 0;
    const [x] = rest.splice(k, 1);
    out.push(x);
    for (const a of d.arrows)
      if (a.from === x.id && a.to !== x.id)
        left.set(a.to, (left.get(a.to) ?? 0) - 1);
  }
  return out;
}

const NEW_MS = 45_000;

/** The whole sketch as words: each subject a section, a map as its directions and ideas, a diagram as its parts in order. */
function SketchList(props: {
  b: BrainstormView;
  shown: Array<{ s: SketchSubject; i: number }>;
  liveId: string | null;
  /** No heading per subject: the row above names it. */ plain?: boolean;
  only: BrainCaught["kind"] | null;
  acts?: SketchActs;
  heard?: { speaker: string; text: string } | null;
}) {
  const { b, only } = props;
  const live = b.status === "live";
  const fresh = (ts: number) => live && Date.now() - ts < NEW_MS;
  const marks = (caught: BrainCaught[]) =>
    (["action", "decision", "question"] as const).map((kind) => {
      const n = caught.filter((c) => c.kind === kind).length;
      const Icon = KIND[kind].Icon;
      return n ? (
        <i
          key={kind}
          className={`brain-outline-mark ${kind}`}
          title={`${KIND[kind].label}: ${n}`}
        >
          <Icon /> {n}
        </i>
      ) : null;
    });
  const lit = (caught: BrainCaught[]) =>
    !only || caught.some((c) => c.kind === only);
  const liveSection = useRef<HTMLElement>(null);
  return (
    <div className="sk-list">
      {props.shown.map(({ s, i }) => {
        const nodes = mapNodes(b, s, i);
        const dirs = nodes.filter((n) => !n.parent);
        const d = s.diagram ?? EMPTY;
        const name = (id: string) =>
          d.boxes.find((x) => x.id === id)?.label ?? "";
        const empty = s.style === "diagram" ? !d.boxes.length : !dirs.length;
        return (
          <section
            key={s.id}
            className="sk-list-subject"
            ref={s.id === props.liveId ? liveSection : undefined}
          >
            {!props.plain && (
              <header>
                <StyleChip
                  subject={s}
                  onPick={
                    props.acts
                      ? (style) => props.acts!.style(s.id, style)
                      : undefined
                  }
                />
                {s.id === props.liveId && props.shown.length > 1 && (
                  <i className="sk-live" aria-label="Live" />
                )}
                <h3 dir="auto">{s.title}</h3>
              </header>
            )}
            {empty ? (
              props.shown.length === 1 ? (
                <Listening b={b} heard={props.heard} />
              ) : (
                <p className="muted">Nothing yet.</p>
              )
            ) : s.style === "diagram" ? (
              <ol className="sk-steps">
                {inOrder(d).map((x, k) => (
                  <li
                    key={x.id}
                    className={`${x.suggested ? "suggested" : ""}${fresh(x.ts) ? " new" : ""}${lit(x.caught) ? "" : " dim"}`}
                  >
                    <i className="sk-n">{k + 1}</i>
                    <span className="sk-step">
                      <span className="brain-outline-idea">
                        <strong dir="auto">{x.label}</strong>
                        {marks(x.caught)}
                      </span>
                      {x.detail && (
                        <span className="brain-outline-detail muted" dir="auto">
                          {x.detail}
                        </span>
                      )}
                      {d.arrows
                        .filter((a) => a.from === x.id && a.label)
                        .map((a) => (
                          <span
                            key={a.id}
                            className="sk-leads muted"
                            dir="auto"
                          >
                            {a.label} → {name(a.to)}
                          </span>
                        ))}
                      {x.suggested && props.acts && (
                        <span className="design-ask">
                          <button
                            type="button"
                            className="design-yes"
                            onClick={() => props.acts!.keep(s.id, x.id)}
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            className="design-no"
                            onClick={() =>
                              props.acts!.edit(s.id, x.id, "remove")
                            }
                          >
                            Drop
                          </button>
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="brain-outline">
                {dirs.map((dir) => (
                  <section key={dir.id}>
                    <h4 dir="auto">{dir.label}</h4>
                    <ul>
                      {nodes
                        .filter((n) => n.parent === dir.id)
                        .map((n) => (
                          <li
                            key={n.id}
                            className={`${fresh(n.ts) ? "new" : ""}${lit(n.caught) ? "" : " dim"}`}
                          >
                            <span className="brain-outline-idea">
                              <strong dir="auto">{n.label}</strong>
                              {n.by && <span className="muted">{n.by}</span>}
                              {marks(n.caught)}
                            </span>
                            {n.detail && (
                              <span
                                className="brain-outline-detail muted"
                                dir="auto"
                              >
                                {n.detail}
                              </span>
                            )}
                          </li>
                        ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

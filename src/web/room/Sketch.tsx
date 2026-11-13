// The sketch: the one board a call draws on (server/sketch.ts). It holds every subject the talk was
// on, each drawn as a map (BrainMap) or as a diagram (DesignBoard). The subject the talk is on fills
// the canvas and the others wait small at the side; a pill per subject brings one back. Each subject
// has a chip saying how it is drawn, and picking the other way redraws just that subject. Nobody
// drags or draws here: what is wrong is fixed by a click on it, or by telling Stand.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Share2, Workflow } from "lucide-react";
import { UNTITLED_DESIGN, subjectNodes, type BrainCaught, type BrainNode, type BrainstormView, type DesignBox, type DesignDiagram, type SketchStyle, type SketchSubject } from "../../shared/protocol.ts";
import { BrainMap, Face, KIND, KINDS } from "./BrainMap.tsx";
import { DesignBoard } from "./DesignBoard.tsx";

/** What people in the call can do to a sketch. Left out where it is only read (its page). */
export interface SketchActs {
  style: (subject: string, style: SketchStyle) => void;
  edit: (subject: string, id: string, op: "rename" | "remove" | "move", arg?: { label?: string; to?: string }) => void;
  undo: () => void;
  offer: (take: boolean) => void;
  keep: (subject: string, id: string) => void;
}

const EMPTY: DesignDiagram = { boxes: [], arrows: [] };
const STYLE: Record<SketchStyle, { label: string; about: string; Icon: typeof Share2 }> = {
  map: { label: "Map", about: "Ideas around one question", Icon: Share2 },
  diagram: { label: "Diagram", about: "Steps and parts, and how they connect", Icon: Workflow },
};

/** A sketch's subjects, for one from before sketches too (the server sends them for every one now). */
export function subjectsOf(b: BrainstormView): SketchSubject[] {
  const all: SketchSubject[] = b.subjects?.length ? b.subjects : [{ id: "s0", title: b.prompt, style: b.design ? "diagram" : "map", ...(b.design ? { diagram: b.design } : {}) }];
  // One opened with nothing typed has no name until the talk gives it one.
  return all.map((s) => (s.title === UNTITLED_DESIGN ? { ...s, title: UNNAMED } : s));
}
const UNNAMED = "This call";

const mapNodes = (b: BrainstormView, s: SketchSubject, i: number): BrainNode[] => subjectNodes(b.nodes, i === 0 ? { title: b.prompt } : s, i === 0).map(({ cluster: _c, ...n }) => n);

/** How much a subject holds as it is drawn, and what that is called. */
export function subjectCount(b: BrainstormView, s: SketchSubject, i: number): { n: number; word: string } {
  if (s.style === "diagram") {
    const n = s.diagram?.boxes.length ?? 0;
    return { n, word: n === 1 ? "part" : "parts" };
  }
  const n = mapNodes(b, s, i).filter((x) => x.parent).length;
  return { n, word: n === 1 ? "idea" : "ideas" };
}

/** The subjects worth showing: one that opened with nothing typed and still holds nothing steps aside once the talk has named others. */
export function shownSubjects(b: BrainstormView): Array<{ s: SketchSubject; i: number }> {
  const all = subjectsOf(b).map((s, i) => ({ s, i }));
  const real = all.filter(({ s, i }) => !(i === 0 && s.title === UNNAMED && subjectCount(b, s, i).n === 0));
  return real.length ? real : all.slice(0, 1);
}

/** One subject as the brainstorm its own component draws: its title in the middle, its circles or its diagram. */
function viewOf(b: BrainstormView, s: SketchSubject, i: number): BrainstormView {
  return { ...b, prompt: s.title, nodes: mapNodes(b, s, i), design: s.diagram ?? EMPTY, context: i === 0 ? b.context : undefined, subjects: undefined };
}

function caughtOf(b: BrainstormView, s: SketchSubject, i: number): BrainCaught[] {
  return s.style === "diagram" ? (s.diagram?.boxes ?? []).flatMap((x) => x.caught) : mapNodes(b, s, i).flatMap((n) => n.caught);
}

export function StyleChip(props: { subject: SketchSubject; onPick?: (style: SketchStyle) => void }) {
  const [open, setOpen] = useState(false);
  const { Icon, label } = STYLE[props.subject.style];
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    return () => (window.removeEventListener("click", close), window.removeEventListener("keydown", key));
  }, [open]);
  if (!props.onPick) {
    return (
      <span className="sk-chip plain" title={STYLE[props.subject.style].about}>
        <Icon size={13} aria-hidden /> {label}
      </span>
    );
  }
  return (
    <span className="sk-chip-wrap" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`sk-chip${open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} title="How this subject is drawn" onClick={() => setOpen((v) => !v)}>
        <Icon size={13} aria-hidden /> {label} <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <span className="sk-menu" role="menu">
          {(["diagram", "map"] as const).map((k) => (
            <button key={k} type="button" role="menuitemradio" aria-checked={props.subject.style === k} className={props.subject.style === k ? "on" : ""} onClick={() => (setOpen(false), props.subject.style !== k && props.onPick!(k))}>
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
function Listening(props: { b: BrainstormView; heard?: { speaker: string; text: string } | null }) {
  const { b } = props;
  if (b.status !== "live") return <div className="sk-empty"><p className="muted">Nothing was drawn for this one.</p></div>;
  return (
    <div className="sk-empty">
      {b.heard === "failed" ? (
        <>
          <p className="sk-empty-head">Stand couldn't read the talk just now.</p>
          <p className="muted">It tries again on the next thing said.</p>
        </>
      ) : (
        <>
          <i className={`sk-pulse${b.busy ? " busy" : ""}`} aria-hidden />
          <p className="sk-empty-head">{b.heard === "nothing" ? "Listening. Nothing drawable heard yet." : "Listening."}</p>
          <p className="muted">Stand draws once someone names ideas, steps or parts.</p>
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
  as: "picture" | "list";
  /** The subject picked on this screen; null follows the talk. */
  subject: string | null;
  onSubject: (id: string | null) => void;
  /** The last line said in the call, for the listening state. */
  heard?: { speaker: string; text: string } | null;
  className?: string;
}) {
  const b = props.brainstorm;
  const live = b.status === "live";
  const shown = shownSubjects(b);
  const liveId = live ? (shown.find((x) => x.s.id === b.liveSubject)?.s.id ?? shown[0].s.id) : null;
  const picked = props.subject && shown.some((x) => x.s.id === props.subject) ? props.subject : null;
  const mainId = picked ?? liveId ?? (shown.find((x) => subjectCount(b, x.s, x.i).n > 0) ?? shown[0]).s.id;
  const main = shown.find((x) => x.s.id === mainId)!;
  const others = shown.filter((x) => x.s.id !== mainId);
  const acts = live ? props.acts : undefined;

  // To-dos, decisions and open questions caught on anything on the sketch: one set of counts, and one filter for all of it.
  const [only, setOnly] = useState<BrainCaught["kind"] | null>(null);
  const all = shown.flatMap(({ s, i }) => caughtOf(b, s, i));
  const totals = KINDS.map((k) => ({ ...k, n: new Set(all.filter((c) => c.kind === k.kind).map((c) => c.id)).size })).filter((k) => k.n > 0);
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
  // The last change can be taken back until it goes stale.
  const [, tick] = useState(0);
  const undo = live && b.undo && Date.now() - b.undo.at < 30_000 ? b.undo : null;
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(500, 30_000 - (Date.now() - undo.at)));
    return () => clearTimeout(t);
  }, [undo?.at]);
  const offer = live && b.offer ? (shown.find((x) => x.s.id === b.offer!.subject) ?? null) : null;

  const pills = (shown.length > 1 || totals.length > 0) && (
    <div className="sk-bar">
      {shown.length > 1 && (
        <span className="sk-subjects" role="tablist" aria-label="Subjects">
          {shown.map(({ s, i }) => {
            const { n } = subjectCount(b, s, i);
            return (
              <button key={s.id} type="button" role="tab" aria-selected={s.id === mainId} className={`rp-pill sk-subject${s.id === mainId ? " on" : ""}${s.id === liveId ? " live" : ""}`} title={s.id === liveId ? "The talk is on this now" : undefined} onClick={() => props.onSubject(s.id === liveId ? null : s.id)}>
                {s.id === liveId && <i className="sk-live" aria-label="Live" />}
                <span dir="auto">{s.title}</span>
                {n > 0 && <span className="count">{n}</span>}
              </button>
            );
          })}
        </span>
      )}
      <span className="rp-grow" />
      {totals.length > 0 && (
        <span className="sk-kinds" role="group" aria-label="Show one kind">
          {totals.map(({ kind, Icon, many, n }) => (
            <button key={kind} type="button" className={`brain-kind-pill ${kind}${only === kind ? " on" : ""}`} aria-pressed={only === kind} onClick={() => setOnly(only === kind ? null : kind)}>
              <Icon size={13} />
              {!props.phone && many}
              <span>{n}</span>
            </button>
          ))}
        </span>
      )}
    </div>
  );

  const dock = (offer || undo || why) && (
    <div className="sk-dock" role="status">
      {offer ? (
        <div className="nudge sk-note">
          <button type="button" className="primary next-do" disabled={!acts} onClick={() => acts?.offer(true)}>
            Redraw
          </button>
          <span className="agent-mark" aria-hidden>
            ✦
          </span>
          <span className="nudge-text">
            {b.offer!.style === "diagram" ? "This is turning into steps. Redraw " : "This sounds like ideas. Redraw "}
            <strong dir="auto">{offer.s.title}</strong> as a {b.offer!.style}?
          </span>
          <button type="button" className="link muted" aria-label="No thanks" disabled={!acts} onClick={() => acts?.offer(false)}>
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
          <button type="button" className="link" disabled={!acts} onClick={() => acts?.undo()}>
            Undo
          </button>
        </div>
      ) : (
        why && (
          <div className="nudge sk-note">
            <span className="agent-mark" aria-hidden>
              ✦
            </span>
            <span className="nudge-text">New subject. Drawn as a diagram because steps were heard.</span>
            <button type="button" className="link" disabled={!acts} onClick={() => (acts?.style(why.id, "map"), setTold((x) => [...x, why.id]))}>
              Redraw as map
            </button>
            <button type="button" className="link muted" aria-label="Close" onClick={() => setTold((x) => [...x, why.id])}>
              ✕
            </button>
          </div>
        )
      )}
    </div>
  );

  if (props.as === "list") {
    return (
      <div className={`sketch as-list${props.phone ? " phone" : ""}${props.className ? ` ${props.className}` : ""}`}>
        {totals.length > 0 && pills}
        <SketchList b={b} shown={shown} liveId={liveId} only={only} acts={acts} heard={props.heard} />
        {dock}
      </div>
    );
  }

  const draw = ({ s, i }: { s: SketchSubject; i: number }) => {
    const v = viewOf(b, s, i);
    if (subjectCount(b, s, i).n === 0 && (s.style === "diagram" || !v.nodes.length)) return <Listening b={b} heard={props.heard} />;
    if (s.style === "diagram")
      return (
        <DesignBoard
          key={`${s.id}:d`}
          brainstorm={v}
          bare
          only={only}
          onKeep={acts ? (id) => acts.keep(s.id, id) : undefined}
          onDrop={acts ? (id) => acts.edit(s.id, id, "remove") : undefined}
          onRename={acts ? (id, label) => acts.edit(s.id, id, "rename", { label }) : undefined}
        />
      );
    return (
      <BrainMap
        key={`${s.id}:m`}
        brainstorm={v}
        only={only}
        onRemove={acts ? (id) => acts.edit(s.id, id, "remove") : undefined}
        onRename={acts ? (id, label) => acts.edit(s.id, id, "rename", { label }) : undefined}
        onMove={acts ? (id, to) => acts.edit(s.id, id, "move", { to }) : undefined}
        moveTo={shown.filter((x) => x.s.id !== s.id && x.s.style === "map").map((x) => ({ id: x.s.id, label: x.s.title }))}
      />
    );
  };

  return (
    <div className={`sketch${props.phone ? " phone" : ""}${props.className ? ` ${props.className}` : ""}`}>
      {pills}
      <div className="sk-body">
        {!props.phone && others.length > 0 && (
          <aside className="sk-side" aria-label="Other subjects">
            {others.map((x) => (
              <button key={x.s.id} type="button" className={`sk-thumb${x.s.id === liveId ? " live" : ""}`} onClick={() => props.onSubject(x.s.id === liveId ? null : x.s.id)} title={`Show ${x.s.title}`}>
                <span className="sk-thumb-pic" aria-hidden>
                  <Thumb b={b} s={x.s} i={x.i} />
                </span>
                <span className="sk-thumb-name">
                  {x.s.id === liveId && <i className="sk-live" aria-label="Live" />}
                  <span dir="auto">{x.s.title}</span>
                </span>
              </button>
            ))}
          </aside>
        )}
        <section className="sk-main" aria-label={main.s.title}>
          <header className="sk-head">
            <StyleChip subject={main.s} onPick={acts ? (style) => acts.style(main.s.id, style) : undefined} />
            {(main.s.style === "diagram" || shown.length === 1) && <SubjectTitle subject={main.s} onRename={acts ? (label) => acts.edit(main.s.id, main.s.id, "rename", { label }) : undefined} />}
            {live && main.s.id !== liveId && liveId && (
              <button type="button" className="link sk-back" onClick={() => props.onSubject(null)}>
                <i className="sk-live" aria-hidden /> Back to {shown.find((x) => x.s.id === liveId)!.s.title}
              </button>
            )}
            {live && b.busy && <span className="design-busy">Listening…</span>}
          </header>
          <div className="sk-canvas">{draw(main)}</div>
        </section>
      </div>
      {props.phone && shown.length > 1 && (
        <div className="sk-dots" role="tablist" aria-label="Subjects">
          {shown.map(({ s }) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === mainId} aria-label={s.title} className={s.id === mainId ? "on" : ""} onClick={() => props.onSubject(s.id === liveId ? null : s.id)} />
          ))}
        </div>
      )}
      {dock}
    </div>
  );
}

/** A subject kept small at the side: the shape of what it holds, not its words. */
function Thumb({ b, s, i }: { b: BrainstormView; s: SketchSubject; i: number }) {
  const W = 160;
  const H = 84;
  if (s.style === "diagram") {
    const boxes = inOrder(s.diagram ?? EMPTY).slice(0, 8);
    const per = Math.min(4, Math.max(1, boxes.length));
    const at = (k: number) => ({ x: 14 + (k % per) * ((W - 28) / per), y: 16 + Math.floor(k / per) * 34 });
    const bw = (W - 28) / per - 8;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="sk-thumb-svg">
        {boxes.slice(1).map((x, k) => (
          <line key={x.id} x1={at(k).x + bw} y1={at(k).y + 9} x2={at(k + 1).x} y2={at(k + 1).y + 9} />
        ))}
        {boxes.map((x, k) => (
          <rect key={x.id} x={at(k).x} y={at(k).y} width={bw} height={18} rx={4} />
        ))}
      </svg>
    );
  }
  const nodes = mapNodes(b, s, i);
  const dirs = nodes.filter((n) => !n.parent).slice(0, 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sk-thumb-svg">
      {dirs.flatMap((d, k) => {
        const a = -Math.PI * 0.9 + ((k + 0.5) / dirs.length) * Math.PI * 2;
        const x = W / 2 + 34 * Math.cos(a);
        const y = H / 2 + 20 * Math.sin(a);
        const ideas = nodes.filter((n) => n.parent === d.id).slice(0, 4);
        return [
          <line key={`${d.id}l`} x1={W / 2} y1={H / 2} x2={x} y2={y} />,
          ...ideas.flatMap((n, j) => {
            const t = a + (j - (ideas.length - 1) / 2) * 0.32;
            const ix = W / 2 + 64 * Math.cos(t);
            const iy = H / 2 + 34 * Math.sin(t);
            return [<line key={`${n.id}l`} x1={x} y1={y} x2={ix} y2={iy} />, <circle key={n.id} cx={ix} cy={iy} r={3} className="idea" />];
          }),
          <circle key={d.id} cx={x} cy={y} r={5} />,
        ];
      })}
      <rect x={W / 2 - 14} y={H / 2 - 7} width={28} height={14} rx={7} className="centre" />
    </svg>
  );
}

/** A subject's name. A click on it renames the subject for everyone. */
function SubjectTitle(props: { subject: SketchSubject; onRename?: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.subject.title);
  useEffect(() => (setEditing(false), setText(props.subject.title)), [props.subject.id, props.subject.title]);
  if (!editing || !props.onRename) {
    return (
      <button type="button" className="sk-title" dir="auto" disabled={!props.onRename} title={props.onRename ? "Rename" : undefined} onClick={() => setEditing(true)}>
        {props.subject.title}
      </button>
    );
  }
  const save = () => {
    const t = text.trim();
    if (t && t !== props.subject.title) props.onRename!(t);
    setEditing(false);
  };
  return (
    <form className="sk-title-edit" onSubmit={(e) => (e.preventDefault(), save())}>
      <input autoFocus value={text} maxLength={80} aria-label="Subject name" onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
    </form>
  );
}

/** A diagram's boxes in the order its arrows run, so a flow reads top to bottom as a numbered list. */
export function inOrder(d: DesignDiagram): DesignBox[] {
  const left = new Map(d.boxes.map((x) => [x.id, d.arrows.filter((a) => a.to === x.id && a.from !== x.id).length]));
  const out: DesignBox[] = [];
  const rest = [...d.boxes];
  while (rest.length) {
    // The next box nothing still points at; a loop is broken at its earliest box.
    let k = rest.findIndex((x) => (left.get(x.id) ?? 0) <= 0);
    if (k < 0) k = 0;
    const [x] = rest.splice(k, 1);
    out.push(x);
    for (const a of d.arrows) if (a.from === x.id && a.to !== x.id) left.set(a.to, (left.get(a.to) ?? 0) - 1);
  }
  return out;
}

const NEW_MS = 45_000;

/** The whole sketch as words: each subject a section, a map as its directions and ideas, a diagram as its parts in order. */
function SketchList(props: { b: BrainstormView; shown: Array<{ s: SketchSubject; i: number }>; liveId: string | null; only: BrainCaught["kind"] | null; acts?: SketchActs; heard?: { speaker: string; text: string } | null }) {
  const { b, only } = props;
  const live = b.status === "live";
  const fresh = (ts: number) => live && Date.now() - ts < NEW_MS;
  const marks = (caught: BrainCaught[]) =>
    (["action", "decision", "question"] as const).map((kind) => {
      const n = caught.filter((c) => c.kind === kind).length;
      const Icon = KIND[kind].Icon;
      return n ? (
        <i key={kind} className={`brain-outline-mark ${kind}`} title={`${KIND[kind].label}: ${n}`}>
          <Icon /> {n}
        </i>
      ) : null;
    });
  const lit = (caught: BrainCaught[]) => !only || caught.some((c) => c.kind === only);
  const liveSection = useRef<HTMLElement>(null);
  return (
    <div className="sk-list">
      {props.shown.map(({ s, i }) => {
        const nodes = mapNodes(b, s, i);
        const dirs = nodes.filter((n) => !n.parent);
        const d = s.diagram ?? EMPTY;
        const name = (id: string) => d.boxes.find((x) => x.id === id)?.label ?? "";
        const empty = s.style === "diagram" ? !d.boxes.length : !dirs.length;
        return (
          <section key={s.id} className="sk-list-subject" ref={s.id === props.liveId ? liveSection : undefined}>
            <header>
              <StyleChip subject={s} onPick={props.acts ? (style) => props.acts!.style(s.id, style) : undefined} />
              {s.id === props.liveId && props.shown.length > 1 && <i className="sk-live" aria-label="Live" />}
              <h3 dir="auto">{s.title}</h3>
            </header>
            {empty ? (
              props.shown.length === 1 ? (
                <Listening b={b} heard={props.heard} />
              ) : (
                <p className="muted">Nothing yet.</p>
              )
            ) : s.style === "diagram" ? (
              <ol className="sk-steps">
                {inOrder(d).map((x, k) => (
                  <li key={x.id} className={`${x.suggested ? "suggested" : ""}${fresh(x.ts) ? " new" : ""}${lit(x.caught) ? "" : " dim"}`}>
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
                          <span key={a.id} className="sk-leads muted" dir="auto">
                            {a.label} → {name(a.to)}
                          </span>
                        ))}
                      {x.suggested && props.acts && (
                        <span className="design-ask">
                          <button type="button" className="design-yes" onClick={() => props.acts!.keep(s.id, x.id)}>
                            Keep
                          </button>
                          <button type="button" className="design-no" onClick={() => props.acts!.edit(s.id, x.id, "remove")}>
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
                          <li key={n.id} className={`${fresh(n.ts) ? "new" : ""}${lit(n.caught) ? "" : " dim"}`}>
                            <span className="brain-outline-idea">
                              <strong dir="auto">{n.label}</strong>
                              {n.by && <span className="muted">{n.by}</span>}
                              {marks(n.caught)}
                            </span>
                            {n.detail && (
                              <span className="brain-outline-detail muted" dir="auto">
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

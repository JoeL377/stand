// A brainstorm's ideas as one list: every idea on the map, the ones the talk built on most first.
// The map shows how the talk branched; this is for coming back afterwards and finding the ideas
// worth keeping. A star marks one for the whole space, and Starred shows only those.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { IDEA_OUTCOMES, type BrainNode, type BrainstormView } from "../../shared/protocol.ts";
import { StarIcon } from "../icons.tsx";
import { KIND } from "../room/BrainMap.tsx";

const KINDS = ["action", "decision", "question"] as const;
/** How much the talk made of an idea: what was built on it and what was caught on it. */
export const weightOf = (n: BrainNode) => n.points.length + n.caught.length;
/** Ideas only, heaviest first; ties stay in the order they were raised. */
export const rankIdeas = (nodes: BrainNode[]) => nodes.filter((n) => n.parent).sort((a, b) => weightOf(b) - weightOf(a) || a.ts - b.ts);

export function BrainIdeas(props: { brainstorm: BrainstormView; onStar: (idea: string, on: boolean) => void }) {
  const { nodes } = props.brainstorm;
  const starred = useMemo(() => new Set(props.brainstorm.starred ?? []), [props.brainstorm.starred]);
  const [only, setOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const ranked = useMemo(() => rankIdeas(nodes), [nodes]);
  const dirOf = (n: BrainNode) => nodes.find((d) => d.id === n.parent)?.label ?? "";
  const shown = only ? ranked.filter((n) => starred.has(n.id)) : ranked;
  if (!ranked.length) return <div className="bi bi-empty muted">No ideas on the map yet.</div>;
  return (
    <div className="bi">
      <div className="bi-list">
        <div className="bi-bar">
          <button type="button" className={`rp-pill${only ? "" : " on"}`} aria-pressed={!only} onClick={() => setOnly(false)}>
            All <span className="muted">{ranked.length}</span>
          </button>
          <button type="button" className={`rp-pill${only ? " on" : ""}`} aria-pressed={only} onClick={() => setOnly(true)}>
            <StarIcon size={12} on /> Starred <span className="muted">{starred.size}</span>
          </button>
        </div>
        {shown.length === 0 && <p className="bi-none muted">Nothing starred yet.</p>}
        {shown.map((n) => {
          const on = starred.has(n.id);
          const open = openId === n.id;
          const more = n.points.length > 0 || n.caught.length > 0 || !!props.brainstorm.reviewed?.[n.id]?.became;
          const reviewed = props.brainstorm.reviewed?.[n.id];
          return (
            <div key={n.id} className={`bi-row${open ? " open" : ""}`}>
              <button type="button" className={`bi-star${on ? " on" : ""}`} aria-pressed={on} aria-label={on ? `Take the star off ${n.label}` : `Star ${n.label}`} onClick={() => props.onStar(n.id, !on)}>
                <StarIcon size={17} on={on} />
              </button>
              <button type="button" className="bi-main" aria-expanded={more ? open : undefined} disabled={!more} onClick={() => setOpenId(open ? null : n.id)}>
                <span className="bi-top">
                  <strong dir="auto">{n.label}</strong>
                  <span className="bi-dir" dir="auto">{dirOf(n)}</span>
                  {n.by && <span className="bi-by muted">{n.by}</span>}
                  {reviewed && <span className={`rv-wrap-outcome bi-outcome ${reviewed.outcome}`}>{IDEA_OUTCOMES.find((o) => o.id === reviewed.outcome)?.label}</span>}
                  <span className="bi-marks">
                    {n.points.length > 0 && (
                      <i className="brain-badge" title={n.points.length === 1 ? "1 remark built on it" : `${n.points.length} remarks built on it`}>
                        {n.points.length}
                      </i>
                    )}
                    {KINDS.map((kind) => {
                      const c = n.caught.filter((x) => x.kind === kind).length;
                      const { Icon, label } = KIND[kind];
                      return c ? (
                        <i key={kind} className={`brain-kind ${kind}`} title={`${label}: ${c}`}>
                          <Icon size={12} />
                          {c > 1 && c}
                        </i>
                      ) : null;
                    })}
                  </span>
                </span>
                {n.detail && <span className="bi-detail" dir="auto">{n.detail}</span>}
              </button>
              {open && (
                <ul className="bi-more">
                  {reviewed?.became && (
                    <li className="bi-became">
                      <Link to={`/ref/${reviewed.became.kind}/${reviewed.became.id}`}>{reviewed.became.kind === "action" ? "The to-do it became" : "The open question it became"}</Link>
                    </li>
                  )}
                  {n.caught.map((c) => {
                    const { Icon } = KIND[c.kind];
                    return (
                      <li key={c.id} className={`bi-caught ${c.kind}`}>
                        <i className={`brain-kind ${c.kind}`}>
                          <Icon size={12} />
                        </i>
                        <span dir="auto">{c.text}</span>
                      </li>
                    );
                  })}
                  {n.points.map((p, k) => (
                    <li key={k}>
                      <span dir="auto">{p.text}</span>
                      {p.by && <span className="muted"> · {p.by}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A map as a list, for a phone: each direction with its ideas under it. The picture fits the whole
// map into the screen's width, which leaves its labels too small to read there; this reads at once.

import type { BrainNode, BrainstormView } from "../../shared/protocol.ts";
import { KIND, clustersOf } from "./BrainMap.tsx";

const KINDS = ["action", "decision", "question"] as const;
function KindIcon({ kind }: { kind: (typeof KINDS)[number] }) {
  const Icon = KIND[kind].Icon;
  return <Icon />;
}
/** An idea counts as new for this long after it lands, so the eye finds what the talk just added. */
const NEW_MS = 45_000;

export function BrainOutline(props: { brainstorm: BrainstormView }) {
  const { nodes, prompt } = props.brainstorm;
  const dirs = nodes.filter((n) => !n.parent);
  const under = (d: BrainNode) => nodes.filter((n) => n.parent === d.id);
  const live = props.brainstorm.status === "live";
  const fresh = (n: BrainNode) => live && Date.now() - n.ts < NEW_MS;
  return (
    <div className="brain-outline">
      <p className="brain-outline-topic" dir="auto">
        {prompt}
      </p>
      {dirs.length === 0 && (
        <p className="muted">
          {props.brainstorm.heard === "failed" && live
            ? "Stand couldn't read the talk just now. It tries again as you talk."
            : "Nothing on the map yet. Ideas show here as people talk."}
        </p>
      )}
      {[null, ...clustersOf(nodes)].flatMap((c) => [
        ...(c
          ? [
              <p key={`hub:${c}`} className="brain-outline-topic hub" dir="auto">
                {c}
              </p>,
            ]
          : []),
        ...dirs
          .filter((d) => (d.cluster ?? null) === c)
          .map((d) => (
            <section key={d.id}>
              <h4 dir="auto">{d.label}</h4>
              <ul>
                {under(d).map((n) => (
                  <li key={n.id} className={fresh(n) ? "new" : undefined}>
                    <span className="brain-outline-idea">
                      <strong dir="auto">{n.label}</strong>
                      {n.by && <span className="muted">{n.by}</span>}
                      {KINDS.map((kind) => {
                        const count = n.caught.filter((c) => c.kind === kind).length;
                        return count ? (
                          <i key={kind} className={`brain-outline-mark ${kind}`} title={`${KIND[kind].label}: ${count}`}>
                            <KindIcon kind={kind} /> {count}
                          </i>
                        ) : null;
                      })}
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
          )),
      ])}
    </div>
  );
}

// A brainstorm as a word cloud: the words its directions and ideas were said in, bigger the more the
// talk made of them. The map shows how the talk branched; this shows what it kept coming back to.
// Picking a word lists the ideas that mention it.

import { useMemo, useState } from "react";
import type { BrainstormView } from "../../shared/protocol.ts";
import { brainWords, centerOut } from "../brainWords.ts";
import { Face } from "./BrainMap.tsx";

const MIN_PX = 14;
const MAX_PX = 54;

export function BrainWords(props: { brainstorm: BrainstormView; className?: string }) {
  const { nodes } = props.brainstorm;
  const words = useMemo(() => brainWords(nodes), [nodes]);
  const [picked, setPicked] = useState<string | null>(null);
  const top = words[0]?.count ?? 1;
  const low = words.at(-1)?.count ?? 1;
  // Area, not height, should follow the count: a word twice as said looks twice as big, not four times.
  const size = (count: number) => Math.round(MIN_PX + (MAX_PX - MIN_PX) * Math.sqrt((count - low) / Math.max(1, top - low)));
  const on = words.find((w) => w.word === picked) ?? null;
  const mentions = on ? on.nodes.flatMap((id) => nodes.find((n) => n.id === id) ?? []) : [];
  const dirOf = (parent: string | null) => (parent ? (nodes.find((n) => n.id === parent)?.label ?? null) : null);
  return (
    <div className={`brain-words${props.className ? ` ${props.className}` : ""}`} onClick={() => setPicked(null)}>
      {words.length === 0 ? (
        <p className="muted brain-words-empty">Nothing on the map yet. The words show here as the talk goes on.</p>
      ) : (
        <div className="brain-cloud" role="group" aria-label={`The ${words.length} words this brainstorm used most. Pick one to see the ideas that mention it.`}>
          {centerOut(words).map((w) => (
            <button
              key={w.word}
              type="button"
              className={`brain-word${picked === w.word ? " on" : ""}${picked && picked !== w.word ? " dim" : ""}`}
              style={{ fontSize: size(w.count) }}
              aria-pressed={picked === w.word}
              title={`${w.word}: in ${w.nodes.length} ${w.nodes.length === 1 ? "idea" : "ideas"}`}
              onClick={(e) => {
                e.stopPropagation();
                setPicked(picked === w.word ? null : w.word);
              }}
            >
              {w.word}
            </button>
          ))}
        </div>
      )}
      {on && (
        <div className="brain-word-ideas" onClick={(e) => e.stopPropagation()}>
          <h4>
            “{on.word}” is in {mentions.length} {mentions.length === 1 ? "place" : "places"} on the map
          </h4>
          <ul>
            {mentions.map((n) => (
              <li key={n.id}>
                {n.by && <Face name={n.by} />}
                <span className="brain-word-idea">
                  <strong>{n.label}</strong>
                  <span className="muted">{n.parent ? `Idea under ${dirOf(n.parent) ?? "a direction"}` : "Direction"}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

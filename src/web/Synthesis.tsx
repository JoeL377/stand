// Synthesis instructions: what a space asks the agent to pull out of every
// meeting, on top of the default notes. Set on the space (by anyone in it),
// followed in the live notes, and written up as the recap's Synthesis section.

import { Fragment, type ReactNode, useEffect, useState } from "react";
import { MAX_SYNTHESIS_INSTRUCTIONS } from "../shared/protocol.ts";
import { api } from "./api.ts";

const PLACEHOLDER = "e.g. List blockers by person.\nPull out customer quotes verbatim.";
export const SYNTHESIS_HINT = "The agent follows these in its notes and adds a Synthesis section to every recap. The usual to-dos, decisions and questions stay.";

/** The instructions box, as Manage spaces and the space's pop-up show it. */
export function SynthesisField(props: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="synth-field">
      Synthesis instructions
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={PLACEHOLDER}
        maxLength={MAX_SYNTHESIS_INSTRUCTIONS}
        rows={4}
        autoFocus={props.autoFocus}
      />
    </label>
  );
}

/** One line on the space's page: what the space asks for, and a pop-up to change it. */
export function SynthesisLine(props: { roomId: string; instructions: string; onSaved: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const first = props.instructions.split("\n").find((l) => l.trim())?.trim();
  return (
    <>
      <button className={first ? "link small synth-line set" : "link small synth-line"} onClick={() => setOpen(true)} title={props.instructions || SYNTHESIS_HINT}>
        <span className="agent-mark" aria-hidden>
          ✦
        </span>
        <span className="synth-line-text">{first ? `Synthesis: ${first}` : "Add synthesis instructions"}</span>
      </button>
      {open && (
        <SynthesisDialog
          roomId={props.roomId}
          instructions={props.instructions}
          onClose={() => setOpen(false)}
          onSaved={(v) => {
            props.onSaved(v);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function SynthesisDialog(props: { roomId: string; instructions: string; onClose: () => void; onSaved: (v: string) => void }) {
  const [text, setText] = useState(props.instructions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateSpace(props.roomId, { synthesisInstructions: text.trim() });
      props.onSaved(r.synthesisInstructions);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog synth-dialog" role="dialog" aria-modal="true" aria-labelledby="synth-title" onSubmit={save}>
        <div className="sp-newform-head">
          <strong id="synth-title">Synthesis instructions</strong>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="muted small">{SYNTHESIS_HINT} Anyone in the space can change them.</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          maxLength={MAX_SYNTHESIS_INSTRUCTIONS}
          rows={6}
          autoFocus
        />
        {error && <p className="error">{error}</p>}
        <div className="sp-newdialog-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || text.trim() === props.instructions.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

/** Just enough Markdown for a synthesis: ### headings, - and 1. lists, > quotes,
 *  paragraphs, **bold**, *italic* and `code`. Rendered as elements, never as HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<h4 key={i}>{inline(heading[2])}</h4>);
      i++;
      continue;
    }
    const list = /^\s*([-*•]|\d+[.)])\s+/;
    if (list.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && list.test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i].replace(list, ""))}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={`l${i}`}>{items}</ol> : <ul key={`l${i}`}>{items}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={`q${i}`}>{inline(quoted.join(" "))}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*([-*•]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={`p${i}`}>{inline(para.join(" "))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g);
  return parts.map((p, k) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={k}>{p.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(p)) return <code key={k}>{p.slice(1, -1)}</code>;
    if (/^\*[^*\s][^*]*\*$/.test(p)) return <em key={k}>{p.slice(1, -1)}</em>;
    return <Fragment key={k}>{p}</Fragment>;
  });
}

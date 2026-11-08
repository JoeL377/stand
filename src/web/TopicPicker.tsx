import { useId, useState } from "react";
import type { Note } from "../shared/protocol.ts";
import { normalizeTopic, TOPIC_MAX } from "../shared/topics.ts";
import { api } from "./api.ts";
import { useDismiss } from "./useDismiss.ts";

/** A reusable topic label: choose an existing topic, write one, or use the agenda default. */
export function TopicPicker({ note, roomId, topic, inherited, options, onSaved }: {
  note: Note;
  roomId: string;
  topic: string | null;
  inherited: string | null;
  options: string[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const listId = useId();
  const ref = useDismiss<HTMLSpanElement>(open, () => { if (!saving) setOpen(false); });
  async function save(next: string | null) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api.setNoteTopic(roomId, note.id, next);
      onSaved();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally { setSaving(false); }
  }
  return (
    <span className="topic-picker" ref={ref}>
      <button type="button" className={`rc-pill topic-pill${topic ? "" : " unset"}`} aria-label={`Change topic: ${topic ?? "No topic"}`} aria-expanded={open}
        onClick={() => { setValue(topic ?? ""); setError(""); setOpen(!open); }} title="Change topic">
        {topic ?? "+ Topic"}
      </button>
      {open && (
        <span className="topic-pop" role="dialog" aria-label="Change topic" onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); if (!saving) setOpen(false); }
          if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) { e.preventDefault(); void save(normalizeTopic(value)); }
        }}>
          <label htmlFor={`${listId}-input`}>Topic</label>
          <input id={`${listId}-input`} autoFocus list={listId} placeholder="Choose or create a topic" value={value} maxLength={TOPIC_MAX} disabled={saving} onChange={(e) => setValue(e.target.value)} />
          <datalist id={listId}>{options.filter((t) => t.length <= TOPIC_MAX).map((t) => <option key={t} value={t} />)}</datalist>
          <span className="topic-actions">
            <button type="button" disabled={saving} onClick={() => void save(normalizeTopic(value))}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
          </span>
          {inherited && <button type="button" className="topic-default" disabled={saving} onClick={() => void save(null)}>Use agenda topic: {inherited}</button>}
          <button type="button" className="topic-default" disabled={saving} onClick={() => void save("")}>No topic</button>
          {error && <span className="error" role="alert">{error}</span>}
        </span>
      )}
    </span>
  );
}

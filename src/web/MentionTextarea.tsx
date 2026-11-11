// A comment box where typing @ lists the people in the space; picking one writes @Full Name, which
// tags them (shared/mentions.ts). The list opens above the box, as the box sits at the drawer's foot.

import { type KeyboardEvent, type TextareaHTMLAttributes, useId, useRef, useState } from "react";
import type { Person } from "../shared/mentions.ts";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Who can be tagged: the space's people, without you. */
  people: Person[];
};

const PART = "[\\p{L}\\p{N}_.'’-]*";
const TYPING = new RegExp(`(?:^|[^\\p{L}\\p{N}_@])@(${PART}(?: ${PART})?)$`, "u");

export function MentionTextarea({ value, onChange, people, onKeyDown, ...rest }: Props) {
  const box = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<{ start: number; text: string } | null>(null);
  const [active, setActive] = useState(0);

  const q = query?.text.toLowerCase() ?? "";
  const matches = query
    ? people.filter((p) => {
        const name = p.name.toLowerCase();
        return name.startsWith(q) || (!q.includes(" ") && name.split(/\s+/).some((w) => w.startsWith(q)));
      }).slice(0, 6)
    : [];
  const open = matches.length > 0;

  function look(el: HTMLTextAreaElement) {
    const caret = el.selectionStart ?? el.value.length;
    const m = el.selectionStart === el.selectionEnd ? TYPING.exec(el.value.slice(0, caret)) : null;
    setQuery(m ? { start: caret - m[1].length - 1, text: m[1] } : null);
    setActive(0);
  }

  function pick(p: Person) {
    const el = box.current;
    if (!el || !query) return;
    const end = el.selectionStart ?? value.length;
    const tag = `@${p.name} `;
    onChange(value.slice(0, query.start) + tag + value.slice(end));
    const at = query.start + tag.length;
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  function keys(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pick(matches[Math.min(active, matches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        // Closes the list, not the drawer.
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="mention-box">
      <textarea
        {...rest}
        ref={box}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${Math.min(active, matches.length - 1)}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          look(e.target);
        }}
        onKeyDown={keys}
        onKeyUp={(e) => (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") && look(e.currentTarget)}
        onClick={(e) => look(e.currentTarget)}
        onBlur={() => setQuery(null)}
      />
      {open && (
        <ul className="mention-list" id={listId} role="listbox" aria-label="People to tag">
          {matches.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === Math.min(active, matches.length - 1)}
              // Before the box loses focus, so the pick lands.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {p.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

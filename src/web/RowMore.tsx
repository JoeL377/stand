import { useEffect, useRef, useState } from "react";

/** A row's "···": what can be done to it, in a small menu, so the row itself stays quiet. */
export function RowMore(props: { children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The menu shuts first; the panel it sits in stays.
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span className={`row-more${open ? " open" : ""}${props.className ? ` ${props.className}` : ""}`} ref={ref}>
      <button type="button" className="row-more-btn" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <circle cx="3" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="13" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        // A choice shuts the menu; Copy for agent stays a moment so its "Copied" can be read.
        <div className="rp-menu row-menu" role="menu" onClick={(e) => setTimeout(() => setOpen(false), (e.target as HTMLElement).closest(".cfa") ? 1200 : 0)}>
          {props.children}
        </div>
      )}
    </span>
  );
}


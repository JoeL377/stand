import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Deck, DeckDraft, SlideLayout } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { LAYOUTS, NativeSlide, THEMES } from "../slides.tsx";

type EditSlide = DeckDraft["slides"][number];

const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join("");
const blank = (layout: SlideLayout = "bullets"): EditSlide => ({ id: newId(), title: "", layout, body: "", image: null, notes: "" });

const BODY_LABEL: Record<SlideLayout, string> = {
  title: "Subtitle",
  bullets: "Bullets, one per line (indent two spaces for a sub-point)",
  section: "Subtitle",
  image: "Bullets beside the image, one per line",
  quote: "Quote",
};

/** Stand's own slide editor. Every change saves on its own, and a meeting
 *  using the deck shows the edit straight away. */
export function DeckEditorPage() {
  const { deckId = "" } = useParams();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [room, setRoom] = useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = useState<DeckDraft | null>(null);
  const [sel, setSel] = useState(0);
  const [status, setStatus] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [llm, setLlm] = useState(false);

  useEffect(() => {
    api.config().then((c) => setLlm(c.llm), () => {});
    api
      .deck(deckId)
      .then(({ deck, room, slides }) => {
        setDeck(deck);
        setRoom(room);
        setDraft({
          title: deck.title,
          theme: deck.theme,
          slides: slides.map((s) => ({ id: s.id, title: s.title, ...(s.slide ?? { layout: "bullets", body: "", image: null, notes: "" }) })),
        });
      })
      .catch((e) => setError(e.message));
  }, [deckId]);

  // Save a moment after the last change; one request at a time.
  const saving = useRef(false);
  const latest = useRef<DeckDraft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flush = async () => {
    if (saving.current || !latest.current) return;
    const body = latest.current;
    latest.current = null;
    saving.current = true;
    setStatus("saving");
    try {
      await api.saveDeck(deckId, body);
      setStatus(latest.current ? "dirty" : "saved");
    } catch (e) {
      setStatus("error");
      setError((e as Error).message);
    } finally {
      saving.current = false;
      if (latest.current) void flush();
    }
  };
  const change = (next: DeckDraft) => {
    setDraft(next);
    latest.current = next;
    setStatus("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 600);
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (latest.current || saving.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  if (error && !draft) return <div className="loading error">{error}</div>;
  if (!draft || !deck) return <div className="loading">Loading…</div>;
  if (deck.kind !== "native") return <div className="loading">This deck is a PDF; edit it where it was made and upload it again.</div>;

  const cur = draft.slides[Math.min(sel, draft.slides.length - 1)];
  const at = draft.slides.indexOf(cur);
  const setSlides = (slides: EditSlide[], select = sel) => {
    change({ ...draft, slides });
    setSel(Math.max(0, Math.min(select, slides.length - 1)));
  };
  const patch = (p: Partial<EditSlide>) => setSlides(draft.slides.map((s) => (s === cur ? { ...s, ...p } : s)));
  const insert = (items: EditSlide[], after = at) => setSlides([...draft.slides.slice(0, after + 1), ...items, ...draft.slides.slice(after + 1)], after + 1);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= draft.slides.length) return;
    const s = [...draft.slides];
    [s[i], s[j]] = [s[j], s[i]];
    setSlides(s, j);
  };
  const remove = (i: number) => draft.slides.length > 1 && setSlides(draft.slides.filter((_, k) => k !== i), i > 0 ? i - 1 : 0);

  return (
    <div className="editor">
      <header className="editor-top">
        {room && (
          <Link to={`/r/${room.id}`} className="small">
            ← {room.name}
          </Link>
        )}
        <input className="editor-title" value={draft.title} onChange={(e) => change({ ...draft, title: e.target.value })} aria-label="Deck title" />
        <select value={draft.theme} onChange={(e) => change({ ...draft, theme: e.target.value as DeckDraft["theme"] })} aria-label="Theme">
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button onClick={() => setOutlineOpen(true)}>{llm ? "✦ Draft with Claude" : "From outline"}</button>
        <span className={`save-state small ${status}`}>
          {status === "saving" ? "Saving…" : status === "dirty" ? "Editing" : status === "error" ? "Not saved" : "Saved"}
        </span>
        <Link to={`/decks/${deck.id}`} className="small">
          Notes ↗
        </Link>
      </header>
      {status === "error" && error && <p className="error small editor-error">{error}</p>}

      <div className="editor-body">
        <ol className="thumbs">
          {draft.slides.map((s, i) => (
            <li key={s.id} className={i === at ? "thumb on" : "thumb"}>
              <span className="thumb-no">{i + 1}</span>
              <button className="thumb-btn" onClick={() => setSel(i)} aria-label={`Slide ${i + 1}: ${s.title || "Untitled"}`}>
                <NativeSlide deckId={deck.id} theme={draft.theme} title={s.title} slide={s} width={168} />
              </button>
              <span className="thumb-tools">
                <button className="icon" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="icon" title="Move down" disabled={i === draft.slides.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button className="icon" title="Duplicate" onClick={() => insert([{ ...s, id: newId() }], i)}>
                  ⧉
                </button>
                <button className="icon" title="Delete slide" disabled={draft.slides.length < 2} onClick={() => remove(i)}>
                  ✕
                </button>
              </span>
            </li>
          ))}
          <li>
            <button className="add-slide" onClick={() => insert([blank()])}>
              + New slide
            </button>
          </li>
        </ol>

        <div className="editor-canvas">
          <NativeSlide deckId={deck.id} theme={draft.theme} title={cur.title} slide={cur} className="slide-main" />
          <p className="muted small">
            Slide {at + 1} of {draft.slides.length}. Changes show up in the meeting as you type.
          </p>
        </div>

        <aside className="editor-props">
          <label className="field">
            <span>Layout</span>
            <div className="seg-pick">
              {LAYOUTS.map((l) => (
                <button key={l.id} className={cur.layout === l.id ? "on" : undefined} onClick={() => patch({ layout: l.id })}>
                  {l.name}
                </button>
              ))}
            </div>
          </label>
          <label className="field">
            <span>{cur.layout === "quote" ? "Who said it" : "Title"}</span>
            <input value={cur.title} onChange={(e) => patch({ title: e.target.value })} placeholder={cur.layout === "quote" ? "Name, role" : "Slide title"} />
          </label>
          <label className="field">
            <span>{BODY_LABEL[cur.layout]}</span>
            <textarea rows={cur.layout === "bullets" || cur.layout === "image" ? 8 : 3} value={cur.body} onChange={(e) => patch({ body: e.target.value })} />
          </label>
          {cur.layout === "image" && <ImagePicker deckId={deck.id} image={cur.image} onChange={(image) => patch({ image })} />}
          <label className="field">
            <span>Speaker notes (only the host sees these)</span>
            <textarea rows={4} value={cur.notes} onChange={(e) => patch({ notes: e.target.value })} />
          </label>
        </aside>
      </div>

      {outlineOpen && (
        <OutlineDialog
          deckId={deck.id}
          llm={llm}
          onClose={() => setOutlineOpen(false)}
          onSlides={(slides, replace) => {
            const made = slides.map((s) => ({ ...s, id: newId() }));
            if (replace) setSlides(made, 0);
            else insert(made);
            setOutlineOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ImagePicker({ deckId, image, onChange }: { deckId: string; image: string | null; onChange: (image: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("That image is over 10 MB.");
      const res = await fetch(`/api/decks/${deckId}/images`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      onChange(data.image);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <span>Image</span>
      <div className="row">
        <button onClick={() => ref.current?.click()} disabled={busy}>
          {busy ? "Uploading…" : image ? "Replace image" : "Choose image"}
        </button>
        {image && (
          <button className="ghost" onClick={() => onChange(null)}>
            Remove
          </button>
        )}
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function OutlineDialog(props: {
  deckId: string;
  llm: boolean;
  onClose: () => void;
  onSlides: (slides: Array<Omit<EditSlide, "id">>, replace: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (replace: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { slides } = await api.draftSlides(props.deckId, text);
      if (!slides.length) throw new Error("No slides came out of that. Try a heading per slide.");
      props.onSlides(slides, replace);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-label="Make slides" onClick={(e) => e.stopPropagation()}>
        <h2>{props.llm ? "Draft slides with Claude" : "Make slides from an outline"}</h2>
        <p className="muted small">
          {props.llm
            ? "Describe the deck, or paste notes or an outline. Claude keeps an outline's structure and writes the rest."
            : "Paste an outline: # starts a slide, - lines become bullets, > is a quote, Notes: are speaker notes."}
        </p>
        <textarea
          rows={12}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"# Q4 roadmap\nPlatform team\n\n# Where we are\n- Search v2 shipped\n- p95 latency down 40%\nNotes: thank the infra team"}
        />
        {error && <p className="error small">{error}</p>}
        <div className="row end">
          <button className="ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button disabled={busy || !text.trim()} onClick={() => go(true)}>
            Replace all slides
          </button>
          <button className="primary" disabled={busy || !text.trim()} onClick={() => go(false)}>
            {busy ? "Making slides…" : "Add after this slide"}
          </button>
        </div>
      </div>
    </div>
  );
}

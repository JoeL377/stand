import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Deck, Item, Note, RoomState, Segment } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import {
  ChatIcon,
  ChevronIcon,
  CloseIcon,
  DeckIcon,
  EditIcon,
  HistoryIcon,
  MoreIcon,
  PdfIcon,
  PinIcon,
  TaskIcon,
  TicketIcon,
} from "../icons.tsx";
import { uploadDeck } from "../slides.tsx";

export function AgendaPanel(props: {
  roomId: string;
  state: RoomState;
  send: (m: ClientMessage) => void;
  canSteer: boolean;
  segments: Segment[];
  notes: Note[];
}) {
  const { roomId, state, send, canSteer, segments, notes } = props;
  const host = state.participants.find((p) => p.isHost);
  const steerTitle = canSteer
    ? "Open this item: everything said now is recorded against it"
    : `${host?.name ?? "The host"} chooses the item`;
  const { linear, llm } = state.capabilities;
  const [openDecks, setOpenDecks] = useState<Record<string, boolean>>({});
  // One open popover at a time: "head" for + Add, "item:<id>" or "deck:<id>" for a row's menu.
  const [pop, setPop] = useState<string | null>(null);
  const [add, setAdd] = useState<Exclude<AddMode, "pdf"> | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!pop) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".pop-wrap")) setPop(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPop(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [pop]);

  const counts = new Map<string | null, number>();
  for (const s of segments) counts.set(s.itemId, (counts.get(s.itemId) ?? 0) + 1);
  const earlier = new Map<string | null, number>();
  for (const f of state.followUps ?? []) if (!f.doneAt) earlier.set(f.itemId, (earlier.get(f.itemId) ?? 0) + 1);
  // What agents and people reported on each item since last time.
  const reported = new Map<string | null, { n: number; blocked: number }>();
  for (const u of state.updates ?? []) {
    const r = reported.get(u.itemId) ?? { n: 0, blocked: 0 };
    r.n++;
    if (u.status === "blocked") r.blocked++;
    reported.set(u.itemId, r);
  }
  const actions = new Map<string | null, number>();
  for (const n of notes) if (n.kind === "action") actions.set(n.itemId, (actions.get(n.itemId) ?? 0) + 1);

  const row = (it: Item) => {
    const active = it.id === state.focusItemId;
    const n = counts.get(it.id) ?? 0;
    const a = actions.get(it.id) ?? 0;
    const e = earlier.get(it.id) ?? 0;
    const u = reported.get(it.id);
    return (
      <li key={it.id} className={active ? "item active" : "item"}>
        <button className="item-main" disabled={!canSteer} onClick={() => send({ type: "focus", itemId: it.id })} title={steerTitle}>
          {active && it.source === "slide" && <span className="live-dot" aria-label="In focus" />}
          {it.source !== "slide" && (
            <span className={active ? "kind live" : "kind"} title={it.source === "linear" ? "Linear ticket" : "Agenda task"}>
              {it.source === "linear" ? <TicketIcon /> : <TaskIcon />}
            </span>
          )}
          <span className="item-text">
            <span className="item-title" title={it.title}>
              {it.slideNo && <span className="slide-no">{it.slideNo}</span>}
              {it.title}
            </span>
            {active && (it.externalId || n > 0 || a > 0 || e > 0 || u) && (
              <span className="item-meta">
                {[it.externalId, n > 0 && `${n} remark${n === 1 ? "" : "s"}`, a > 0 && `${a} to-do${a === 1 ? "" : "s"}`]
                  .filter(Boolean)
                  .join(" · ")}
                {e > 0 && (
                  <span className="open-count" title="Open action items from earlier meetings">
                    {e} open
                  </span>
                )}
                {u && (
                  <span className={u.blocked ? "update-count blocked" : "update-count"} title="Updates reported since last time">
                    {u.n} update{u.n === 1 ? "" : "s"}
                    {u.blocked > 0 && ` · ${u.blocked} blocked`}
                  </span>
                )}
              </span>
            )}
          </span>
        </button>
        <span className="item-tools">
          {canSteer && (
            <button
              className={state.pinnedBy && active ? "icon on" : "icon"}
              title="Pin: stay on this item even if the screen changes"
              onClick={() => send({ type: "pin", itemId: it.id })}
            >
              <PinIcon />
            </button>
          )}
          <a className="icon" href={`/items/${it.id}`} target="_blank" rel="noreferrer" title="History of this item">
            <HistoryIcon />
          </a>
          {canSteer && (
            <button className="icon" title="Remove from agenda" onClick={() => void api.removeItem(roomId, it.id)}>
              <CloseIcon />
            </button>
          )}
        </span>
      </li>
    );
  };

  // Slides from one deck sit together under the deck's name.
  // The agenda is the parent tier: tasks and decks are its entries, side by
  // side in agenda order, and a deck's slides sit one level down inside it.
  type DeckBlock = { deck: Deck; items: Item[] };
  type Block = { kind: "item"; item: Item } | { kind: "deck"; block: DeckBlock };
  const blocks: Block[] = [];
  for (const it of state.items) {
    const deck = it.deckId ? state.decks.find((d) => d.id === it.deckId) : undefined;
    const last = blocks[blocks.length - 1];
    if (deck && last?.kind === "deck" && last.block.deck.id === deck.id) last.block.items.push(it);
    else if (deck) blocks.push({ kind: "deck", block: { deck, items: [it] } });
    else blocks.push({ kind: "item", item: it });
  }
  const deckOpen = (b: DeckBlock) => openDecks[b.deck.id] ?? b.items.some((i) => i.id === state.focusItemId);

  const addMenu: { mode: AddMode; label: string; hint: string }[] = [
    { mode: "slides", label: "New slides", hint: llm ? "Build a deck here, or let Claude draft it" : "Build a deck in Stand's editor" },
    { mode: "type", label: "Type items", hint: "One agenda item per line" },
    { mode: "pdf", label: "Upload PDF deck", hint: "Each page becomes a slide" },
    ...(linear ? [{ mode: "linear" as const, label: "From Linear", hint: "Issues from a project, cycle or view" }] : []),
  ];
  const pick = (mode: AddMode) => {
    setPop(null);
    if (mode === "pdf") fileRef.current?.click();
    else setAdd(mode);
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploadNote("Reading slides…");
    try {
      await uploadDeck(roomId, file);
      setUploadNote(null);
    } catch (e) {
      setUploadNote((e as Error).message);
    }
  };
  const empty = state.items.length === 0;

  const deckRow = (b: DeckBlock) => {
    const open = deckOpen(b);
    const key = `deck:${b.deck.id}`;
    return (
      <li key={b.deck.id} className={pop === key ? "deck popped" : "deck"}>
        <div className="deck-head">
          <button className="deck-toggle" onClick={() => setOpenDecks((o) => ({ ...o, [b.deck.id]: !open }))} aria-expanded={open}>
            <span
              className={b.items.some((i) => i.id === state.focusItemId) ? "kind live" : "kind"}
              title={b.deck.kind === "native" ? "Slides made in Stand" : "PDF deck"}
            >
              {b.deck.kind === "native" ? <DeckIcon /> : <PdfIcon />}
            </span>
            <span className="item-title">{b.deck.title}</span>
            <span className="deck-count">{b.items.length} slides</span>
            {(() => {
              const e = b.items.reduce((sum, i) => sum + (earlier.get(i.id) ?? 0), 0);
              return e > 0 ? (
                <span className="open-count" title="Open action items on these slides from earlier meetings">
                  {e} open
                </span>
              ) : null;
            })()}
            <span className={open ? "chev open" : "chev"} aria-hidden>
              <ChevronIcon />
            </span>
          </button>
          <span className="item-tools">
            {b.deck.kind === "native" && (
              <a className="icon" href={`/decks/${b.deck.id}/edit`} target="_blank" rel="noreferrer" title="Edit these slides">
                <EditIcon />
              </a>
            )}
            {b.deck.kind !== "native" && <span className="icon spacer" aria-hidden />}
            <span className="pop-wrap">
              <button className="icon" title="More" onClick={() => setPop((p) => (p === key ? null : key))}>
                <MoreIcon />
              </button>
              {pop === key && (
                <div className="add-menu row-menu" role="menu">
                  <a role="menuitem" href={`/decks/${b.deck.id}`} target="_blank" rel="noreferrer" onClick={() => setPop(null)}>
                    <span>Notes for every slide ↗</span>
                  </a>
                  {canSteer && (
                    <button role="menuitem" className="danger-text" onClick={() => (setPop(null), void api.removeDeck(roomId, b.deck.id))}>
                      <span>Remove from agenda</span>
                    </button>
                  )}
                </div>
              )}
            </span>
          </span>
        </div>
        {open && <ol className="items deck-items">{b.items.map((it) => row(it))}</ol>}
      </li>
    );
  };

  return (
    <aside
      className={dropping ? "panel agenda dropping" : "panel agenda"}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        void upload(e.dataTransfer.files[0]);
      }}
    >
      <div className="panel-head">
        <h2>Agenda</h2>
        <div className="add-menu-wrap pop-wrap">
          <button
            className="ghost small add-btn"
            aria-expanded={pop === "head"}
            onClick={() => setPop((p) => (p === "head" ? null : "head"))}
          >
            + Add
          </button>
          {pop === "head" && (
            <div className="add-menu" role="menu">
              {addMenu.map((o) => (
                <button key={o.mode} role="menuitem" onClick={() => pick(o.mode)}>
                  <span>{o.label}</span>
                  <span className="muted">{o.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      {state.pinnedBy && (
        <div className="pinned-note">
          <PinIcon size={13} /> Pinned by {state.pinnedBy}. The agent won't suggest other items.{" "}
          {canSteer && (
            <button className="link" onClick={() => send({ type: "unpin" })}>
              Unpin
            </button>
          )}
        </div>
      )}
      {uploadNote && (
        <div className="upload-note">
          {uploadNote}
          {uploadNote !== "Reading slides…" && (
            <button className="icon" title="Dismiss" onClick={() => setUploadNote(null)}>
              <CloseIcon />
            </button>
          )}
        </div>
      )}

      {empty && !add ? (
        <div className="agenda-empty">
          <p>Nothing on the agenda yet.</p>
          {addMenu.map((o) => (
            <button key={o.mode} className={o.mode === "slides" ? "primary" : ""} onClick={() => pick(o.mode)}>
              {o.label}
            </button>
          ))}
          <button className="link" onClick={() => void api.loadSample(roomId)}>
            Or load a sample sprint
          </button>
        </div>
      ) : (
        <ol className="items">
          {blocks.map((b) => (b.kind === "item" ? row(b.item) : deckRow(b.block)))}
          <li className={state.focusItemId === null ? "item active" : "item"}>
            <button className="item-main" disabled={!canSteer} title={steerTitle} onClick={() => send({ type: "focus", itemId: null })}>
              <span className={state.focusItemId === null ? "kind live" : "kind"} title="Anything not on the agenda">
                <ChatIcon />
              </span>
              <span className="item-text">
                <span className="item-title muted">General / off-agenda</span>
                {(counts.get(null) ?? 0) > 0 && <span className="item-meta">{counts.get(null)} remarks</span>}
              </span>
            </button>
          </li>
        </ol>
      )}

      {add && <AddForm mode={add} roomId={roomId} llm={llm} onClose={() => setAdd(null)} />}
      {dropping && <div className="drop-hint">Drop a PDF to add it as slides</div>}
    </aside>
  );
}

type AddMode = "slides" | "type" | "pdf" | "linear";

/** The one add form that is open, shown under the agenda with a close button. */
function AddForm({ mode, roomId, llm, onClose }: { mode: Exclude<AddMode, "pdf">; roomId: string; llm: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const title = { slides: "New slides", type: "Type items", linear: "From Linear" }[mode];

  return (
    <div className="add-items">
      <div className="add-head">
        <strong>{title}</strong>
        <button className="icon" title="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {mode === "slides" ? (
        <NewDeck roomId={roomId} llm={llm} onDone={onClose} />
      ) : mode === "type" ? (
        <>
          <textarea
            rows={4}
            autoFocus
            placeholder={"One item per line\nDesign review: settings page\nQ4 hiring plan"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="primary" disabled={busy || !text.trim()} onClick={() => run(() => api.addAgenda(roomId, text.split("\n")))}>
            Add items
          </button>
        </>
      ) : (
        <>
          <input
            autoFocus
            placeholder="Linear project, cycle or view link, or ENG-12, ENG-14"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="primary" disabled={busy || !text.trim()} onClick={() => run(() => api.importLinear(roomId, text))}>
            {busy ? "Loading…" : "Load issues"}
          </button>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Starts a deck in Stand's own editor, optionally drafted from an outline or brief. */
function NewDeck({ roomId, llm, onDone }: { roomId: string; llm: boolean; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const create = async () => {
    // Open the tab now: browsers block windows opened after a network wait.
    const tab = window.open("about:blank", "_blank");
    setBusy(true);
    setError(null);
    try {
      const { deck } = await api.newDeck(roomId, title, brief);
      const url = `/decks/${deck.id}/edit`;
      if (tab) {
        tab.location.href = url;
        onDone();
      } else setMade(url);
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="new-deck">
      <input autoFocus placeholder="Deck title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        rows={3}
        placeholder={
          llm
            ? "Optional: describe the deck or paste notes, and Claude drafts it"
            : "Optional: paste an outline (# per slide, - for bullets)"
        }
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <button className="primary" disabled={busy} onClick={() => void create()}>
        {busy ? (brief.trim() ? "Drafting slides…" : "Creating…") : "Create deck"}
      </button>
      {made && (
        <a href={made} target="_blank" rel="noreferrer">
          Open the editor ↗
        </a>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

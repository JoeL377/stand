import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Deck, Item, Note, RoomState, Segment } from "../../shared/protocol.ts";
import { api } from "../api.ts";
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
  const steerTitle = canSteer ? "Open this item: everything said now is recorded against it" : `${host?.name ?? "The host"} chooses the item`;
  const { linear, llm } = state.capabilities;
  const [openDecks, setOpenDecks] = useState<Record<string, boolean>>({});
  // One open popover at a time: "head" for + Add, "item:<id>" or "deck:<id>" for a row's menu.
  const [pop, setPop] = useState<string | null>(null);
  const [add, setAdd] = useState<{ mode: Exclude<AddMode, "pdf">; parent: Item | null } | null>(null);
  const uploadParent = useRef<string | null>(null);
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
  const actions = new Map<string | null, number>();
  for (const n of notes) if (n.kind === "action") actions.set(n.itemId, (actions.get(n.itemId) ?? 0) + 1);

  const row = (it: Item) => {
    const active = it.id === state.focusItemId;
    const n = counts.get(it.id) ?? 0;
    const a = actions.get(it.id) ?? 0;
    return (
      <li key={it.id} className={(active ? "item active" : "item") + (pop === `item:${it.id}` ? " popped" : "")}>
        <button
          className="item-main"
          disabled={!canSteer}
          onClick={() => send({ type: "focus", itemId: it.id })}
          title={steerTitle}
        >
          {active && <span className="live-dot" aria-label="In focus" />}
          <span className="item-text">
            {it.externalId && <span className="key">{it.externalId}</span>}
            <span className="item-title">
              {it.slideNo && <span className="slide-no">{it.slideNo}</span>}
              {it.title}
            </span>
            {(n > 0 || a > 0) && (
              <span className="item-meta">
                {n > 0 && `${n} remark${n === 1 ? "" : "s"}`}
                {a > 0 && ` · ${a} action${a === 1 ? "" : "s"}`}
              </span>
            )}
          </span>
        </button>
        <span className="item-tools">
          {!it.deckId && (
            <span className="pop-wrap">
              <button className="icon" title="Add slides under this item" onClick={() => setPop((p) => (p === `item:${it.id}` ? null : `item:${it.id}`))}>
                +
              </button>
              {pop === `item:${it.id}` && (
                <div className="add-menu row-menu" role="menu">
                  <div className="menu-label">Add under “{it.title}”</div>
                  {underMenu.map((o) => (
                    <button key={o.mode} role="menuitem" onClick={() => pick(o.mode, it)}>
                      <span>{o.label}</span>
                    </button>
                  ))}
                  {moveable.length > 0 && <div className="menu-label">Put existing slides here</div>}
                  {moveable.map((d) => (
                    <button key={d.id} role="menuitem" onClick={() => move(d.id, it.id)}>
                      <span>{d.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {canSteer && (
            <button
              className={state.pinnedBy && active ? "icon on" : "icon"}
              title="Pin: stay on this item even if the screen changes"
              onClick={() => send({ type: "pin", itemId: it.id })}
            >
              📌
            </button>
          )}
          <a className="icon" href={`/items/${it.id}`} target="_blank" rel="noreferrer" title="History of this item">
            ↗
          </a>
          {canSteer && (
            <button className="icon" title="Remove from agenda" onClick={() => void api.removeItem(roomId, it.id)}>
              ✕
            </button>
          )}
        </span>
      </li>
    );
  };

  // Slides from one deck sit together under the deck's name.
  // The agenda is the top tier. A deck either sits under the agenda item it's
  // presented in, or stands on its own where its slides are in the order.
  type DeckBlock = { deck: Deck; items: Item[] };
  const typed = new Set(state.items.filter((i) => !i.deckId).map((i) => i.id));
  const deckBlocks = new Map<string, DeckBlock>();
  for (const it of state.items) {
    const deck = it.deckId ? state.decks.find((d) => d.id === it.deckId) : undefined;
    if (!deck) continue;
    const b = deckBlocks.get(deck.id) ?? { deck, items: [] };
    b.items.push(it);
    deckBlocks.set(deck.id, b);
  }
  const parentOf = (d: Deck) => (d.parentItemId && typed.has(d.parentItemId) ? d.parentItemId : null);
  type Block = { kind: "item"; item: Item; children: DeckBlock[] } | { kind: "deck"; block: DeckBlock };
  const blocks: Block[] = [];
  const placed = new Set<string>();
  for (const it of state.items) {
    if (!it.deckId) {
      blocks.push({ kind: "item", item: it, children: [...deckBlocks.values()].filter((b) => parentOf(b.deck) === it.id) });
      continue;
    }
    const b = deckBlocks.get(it.deckId);
    if (!b || placed.has(b.deck.id) || parentOf(b.deck)) continue;
    placed.add(b.deck.id);
    blocks.push({ kind: "deck", block: b });
  }
  const deckOpen = (b: DeckBlock) => openDecks[b.deck.id] ?? b.items.some((i) => i.id === state.focusItemId);
  const typedItems = state.items.filter((i) => !i.deckId);
  // Decks not already under some item, offered when putting slides under one.
  const moveable = [...deckBlocks.values()].filter((b) => !parentOf(b.deck)).map((b) => b.deck);
  const move = (deckId: string, parentItemId: string | null) => {
    setPop(null);
    void api.moveDeck(deckId, parentItemId);
  };

  const addMenu: { mode: AddMode; label: string; hint: string }[] = [
    { mode: "slides", label: "New slides", hint: llm ? "Build a deck here, or let Claude draft it" : "Build a deck in Stand's editor" },
    { mode: "type", label: "Type items", hint: "One agenda item per line" },
    { mode: "pdf", label: "Upload PDF deck", hint: "Each page becomes a slide" },
    ...(linear ? [{ mode: "linear" as const, label: "From Linear", hint: "Issues from a project, cycle or view" }] : []),
  ];
  const underMenu = addMenu.filter((o) => o.mode === "slides" || o.mode === "pdf");
  const pick = (mode: AddMode, parent: Item | null = null) => {
    setPop(null);
    uploadParent.current = parent?.id ?? null;
    if (mode === "pdf") fileRef.current?.click();
    else setAdd({ mode, parent });
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploadNote("Reading slides…");
    try {
      await uploadDeck(roomId, file, uploadParent.current);
      setUploadNote(null);
    } catch (e) {
      setUploadNote((e as Error).message);
    }
  };
  const empty = state.items.length === 0;

  const deckRow = (b: DeckBlock) => {
    const open = deckOpen(b);
    const key = `deck:${b.deck.id}`;
    const parent = parentOf(b.deck);
    return (
      <li key={b.deck.id} className={pop === key ? "deck popped" : "deck"}>
        <div className="deck-head">
          <button className="deck-toggle" onClick={() => setOpenDecks((o) => ({ ...o, [b.deck.id]: !open }))} aria-expanded={open}>
            <span aria-hidden>{open ? "▾" : "▸"}</span>
            <span className="item-title">{b.deck.title}</span>
            <span className="muted">{b.items.length} slides</span>
          </button>
          <span className="item-tools">
            {b.deck.kind === "native" && (
              <a className="icon" href={`/decks/${b.deck.id}/edit`} target="_blank" rel="noreferrer" title="Edit these slides">
                ✎
              </a>
            )}
            <span className="pop-wrap">
              <button className="icon" title="More" onClick={() => setPop((p) => (p === key ? null : key))}>
                ⋯
              </button>
              {pop === key && (
                <div className="add-menu row-menu" role="menu">
                  <a role="menuitem" href={`/decks/${b.deck.id}`} target="_blank" rel="noreferrer" onClick={() => setPop(null)}>
                    <span>Notes for every slide ↗</span>
                  </a>
                  {typedItems.some((t) => t.id !== parent) && <div className="menu-label">Move under</div>}
                  {typedItems
                    .filter((t) => t.id !== parent)
                    .map((t) => (
                      <button key={t.id} role="menuitem" onClick={() => move(b.deck.id, t.id)}>
                        <span>{t.title}</span>
                      </button>
                    ))}
                  {parent && (
                    <button role="menuitem" onClick={() => move(b.deck.id, null)}>
                      <span>Take out on its own</span>
                    </button>
                  )}
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
        uploadParent.current = null;
        void upload(e.dataTransfer.files[0]);
      }}
    >
      <div className="panel-head">
        <h2>Agenda</h2>
        <div className="add-menu-wrap pop-wrap">
          <button className="ghost small add-btn" aria-expanded={pop === "head"} onClick={() => setPop((p) => (p === "head" ? null : "head"))}>
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
          📌 Pinned by {state.pinnedBy}. The agent won't suggest other items.{" "}
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
              ✕
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
          {blocks.map((b) =>
            b.kind === "item" ? (
              b.children.length ? (
                <li key={b.item.id} className="parent">
                  <ol className="items">{row(b.item)}</ol>
                  <ol className="items children">{b.children.map(deckRow)}</ol>
                </li>
              ) : (
                row(b.item)
              )
            ) : (
              deckRow(b.block)
            ),
          )}
          <li className={state.focusItemId === null ? "item active" : "item"}>
            <button className="item-main" disabled={!canSteer} title={steerTitle} onClick={() => send({ type: "focus", itemId: null })}>
              {state.focusItemId === null && <span className="live-dot" />}
              <span className="item-text">
                <span className="item-title muted">General / off-agenda</span>
                {(counts.get(null) ?? 0) > 0 && <span className="item-meta">{counts.get(null)} remarks</span>}
              </span>
            </button>
          </li>
        </ol>
      )}

      {add && <AddForm mode={add.mode} parent={add.parent} roomId={roomId} llm={llm} onClose={() => setAdd(null)} />}
      {dropping && <div className="drop-hint">Drop a PDF to add it as slides</div>}
    </aside>
  );
}

type AddMode = "slides" | "type" | "pdf" | "linear";

/** The one add form that is open, shown under the agenda with a close button. */
function AddForm({
  mode,
  parent,
  roomId,
  llm,
  onClose,
}: {
  mode: Exclude<AddMode, "pdf">;
  parent: Item | null;
  roomId: string;
  llm: boolean;
  onClose: () => void;
}) {
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
  const title = { slides: "New slides", type: "Type items", linear: "From Linear" }[mode] + (parent ? ` in “${parent.title}”` : "");

  return (
    <div className="add-items">
      <div className="add-head">
        <strong>{title}</strong>
        <button className="icon" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {mode === "slides" ? (
        <NewDeck roomId={roomId} parentItemId={parent?.id ?? null} llm={llm} onDone={onClose} />
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
          <input autoFocus placeholder="Linear project, cycle or view link, or ENG-12, ENG-14" value={text} onChange={(e) => setText(e.target.value)} />
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
function NewDeck({ roomId, parentItemId, llm, onDone }: { roomId: string; parentItemId: string | null; llm: boolean; onDone: () => void }) {
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
      const { deck } = await api.newDeck(roomId, title, brief, parentItemId);
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
        placeholder={llm ? "Optional: describe the deck or paste notes, and Claude drafts it" : "Optional: paste an outline (# per slide, - for bullets)"}
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

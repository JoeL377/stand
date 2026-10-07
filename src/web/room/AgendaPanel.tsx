import { useRef, useState } from "react";
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
  const [adding, setAdding] = useState(state.items.length === 0);
  const [openDecks, setOpenDecks] = useState<Record<string, boolean>>({});

  const counts = new Map<string | null, number>();
  for (const s of segments) counts.set(s.itemId, (counts.get(s.itemId) ?? 0) + 1);
  const actions = new Map<string | null, number>();
  for (const n of notes) if (n.kind === "action") actions.set(n.itemId, (actions.get(n.itemId) ?? 0) + 1);

  const row = (it: Item) => {
    const active = it.id === state.focusItemId;
    const n = counts.get(it.id) ?? 0;
    const a = actions.get(it.id) ?? 0;
    return (
      <li key={it.id} className={active ? "item active" : "item"}>
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
          {adding && (
            <button className="icon" title="Remove from agenda" onClick={() => void api.removeItem(roomId, it.id)}>
              ✕
            </button>
          )}
        </span>
      </li>
    );
  };

  // Slides from one deck sit together under the deck's name.
  type Block = { kind: "item"; item: Item } | { kind: "deck"; deck: Deck; items: Item[] };
  const blocks: Block[] = [];
  for (const it of state.items) {
    const deck = it.deckId ? state.decks.find((d) => d.id === it.deckId) : undefined;
    const last = blocks[blocks.length - 1];
    if (deck && last?.kind === "deck" && last.deck.id === deck.id) last.items.push(it);
    else if (deck) blocks.push({ kind: "deck", deck, items: [it] });
    else blocks.push({ kind: "item", item: it });
  }
  const deckOpen = (b: Extract<Block, { kind: "deck" }>) =>
    openDecks[b.deck.id] ?? b.items.some((i) => i.id === state.focusItemId);

  return (
    <aside className="panel agenda">
      <div className="panel-head">
        <h2>Agenda</h2>
        <button className="ghost small" onClick={() => setAdding((a) => !a)}>
          {adding ? "Done" : "+ Add"}
        </button>
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

      <ol className="items">
        {blocks.map((b) =>
          b.kind === "item" ? (
            row(b.item)
          ) : (
            <li key={b.deck.id} className="deck">
              <div className="deck-head">
                <button className="deck-toggle" onClick={() => setOpenDecks((o) => ({ ...o, [b.deck.id]: !deckOpen(b) }))} aria-expanded={deckOpen(b)}>
                  <span aria-hidden>{deckOpen(b) ? "▾" : "▸"}</span>
                  <span className="item-title">{b.deck.title}</span>
                  <span className="muted">{b.items.length} slides</span>
                </button>
                <a className="icon" href={`/decks/${b.deck.id}`} target="_blank" rel="noreferrer" title="Notes for every slide in this deck">
                  ↗
                </a>
                {adding && (
                  <button className="icon" title="Remove this deck from the agenda" onClick={() => void api.removeDeck(roomId, b.deck.id)}>
                    ✕
                  </button>
                )}
              </div>
              {deckOpen(b) && <ol className="items deck-items">{b.items.map((it) => row(it))}</ol>}
            </li>
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

      {adding && <AddItems roomId={roomId} linear={state.capabilities.linear} onDone={() => setAdding(false)} />}
    </aside>
  );
}

function AddItems({ roomId, linear, onDone }: { roomId: string; linear: boolean; onDone: () => void }) {
  const [tab, setTab] = useState<"agenda" | "linear" | "slides">(linear ? "linear" : "agenda");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = (file: File | undefined) => {
    if (!file) return;
    void run(() => uploadDeck(roomId, file));
  };
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setText("");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-items">
      <div className="tabs small">
        <button className={tab === "linear" ? "tab on" : "tab"} onClick={() => setTab("linear")}>
          From Linear
        </button>
        <button className={tab === "agenda" ? "tab on" : "tab"} onClick={() => setTab("agenda")}>
          Type items
        </button>
        <button className={tab === "slides" ? "tab on" : "tab"} onClick={() => setTab("slides")}>
          Slides
        </button>
      </div>
      {tab === "slides" ? (
        <>
          <div
            className={over ? "drop over" : "drop"}
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              upload(e.dataTransfer.files[0]);
            }}
          >
            {busy ? "Reading slides…" : "Drop a PDF of your deck here, or click to choose one"}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <p className="muted small">
            Export from Keynote, PowerPoint or Google Slides (File → Download → PDF). Each slide becomes an agenda item.
          </p>
        </>
      ) : tab === "agenda" ? (
        <>
          <textarea
            rows={4}
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
            placeholder="Linear project, cycle or view link, or ENG-12, ENG-14"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!linear}
          />
          <button className="primary" disabled={busy || !linear || !text.trim()} onClick={() => run(() => api.importLinear(roomId, text))}>
            {busy ? "Loading…" : "Load issues"}
          </button>
          {!linear && <p className="muted small">Linear isn't connected on the server yet.</p>}
        </>
      )}
      <button className="link" disabled={busy} onClick={() => run(() => api.loadSample(roomId))}>
        Load a sample sprint
      </button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

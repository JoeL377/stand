import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { AgentCard, Board, ClientMessage, ConxtLive, Discussion, HostView, Item, ListNote, Note, Participant, RoomState, Segment, Snap } from "../../shared/protocol.ts";
import type { RemoteScreen } from "./useMedia.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, initials, keyOf } from "../util.ts";
import { Slide } from "../slides.tsx";
import { CameraIcon } from "../icons.tsx";
import { SnapGallery, SnapNotSaved, removeSnap, takeSnap, type Snapped } from "../Snaps.tsx";
import { macApp } from "../macApp.ts";
import { dismissToast, toast, undoing } from "../Toasts.tsx";
import { BoardStrip, TopicBoard, type Rewind } from "./TopicBoard.tsx";
import { AgentTabMark } from "./AgentCard.tsx";

/** The Mac app's snap shortcut, written out: ⇧ alone reads as an arrow. */
const SNAP_KEYS_WORDS = "Control + Shift + S";

export function Stage(props: {
  state: RoomState;
  me: Participant | undefined;
  focusItem: Item | null;
  canSteer: boolean;
  participantId: string;
  send: (m: ClientMessage) => boolean;
  /** The connection is down: what steers the meeting waits until it's back. */
  offline?: boolean;
  /** The meeting has ended and the notes are being written: nothing steers it any more. */
  ending?: boolean;
  localScreen: MediaStream | null;
  remoteScreen: RemoteScreen | null;
  interims: Record<string, Interim>;
  segments: Segment[];
  /** Live notes: the topics the talk is grouped into, and what came of them. */
  discussions: Discussion[];
  /** The middle board's threads (server/board.ts). */
  board: Board | null;
  /** The board's running list (server/liveList.ts); null when the server keeps none. */
  list: ListNote[] | null;
  /** What ✦ Stand has put on the board (server/meetingAgent.ts); null when the server runs no agent. */
  agentCards: AgentCard[] | null;
  notes: Note[];
  /** Items whose live notes are being redrawn right now (keyed "" for off the agenda). */
  notesBusy: string[];
  livekit: boolean;
  /** Set to a function that snaps the shared screen while one is up, for the pop-out bar. */
  snapRef?: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const { state, focusItem, canSteer, send, localScreen, remoteScreen, interims } = props;
  const suggested = state.suggestion ? state.items.find((i) => i.id === state.suggestion!.itemId) : null;
  const sharer = state.participants.find((p) => p.isSharing);
  const host = state.participants.find((p) => p.isHost);
  // Accepting a nudge moves what was said since it started from this item to the suggested one.
  const movingIds = state.suggestion
    ? props.segments.filter((s) => s.itemId === state.focusItemId && s.ts >= state.suggestion!.since).map((s) => s.id)
    : [];
  const moving = movingIds.length;
  // The host takes a line off the board that Stand got wrong; Undo puts it back.
  const removeNote = (note: Note) => {
    if (!send({ type: "note.remove", noteId: note.id })) return;
    const what = note.kind === "action" ? "to-do" : note.kind;
    toast({ text: `Removed the ${what}`, action: { label: "Undo", run: undoing(() => send({ type: "note.restore", noteId: note.id })) } });
  };
  const accept = () => {
    const n = moving;
    const to = suggested;
    if (!to || !send({ type: "suggestion.accept", itemId: to.id }) || !n) return;
    // Moving remarks is the part people might not have meant, so it can be taken back.
    // The server puts back every remark it moved, including any still arriving.
    toast({
      text: `Moved ${n} remark${n === 1 ? "" : "s"} to ${keyOf(to) ?? to.title}`,
      action: { label: "Undo", run: undoing(() => send({ type: "suggestion.undo" })) },
    });
  };
  // The seat held for a host who dropped: who it waits for, how long, and a way to take it now.
  const [, tick] = useState(0);
  // Counted from when the state arrived, on this computer's clock.
  const holdUntil = useMemo(() => (state.hostAwayMs ? Date.now() + state.hostAwayMs : null), [state.hostAwayMs]);
  useEffect(() => {
    if (!holdUntil) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [holdUntil]);
  // The item changed under you (someone else switched): it fades up so the change registers.
  // Not for the host's own switches, slide flips within a deck, or quick steps through items.
  // A deck counts as one thing here, so flipping its slides never fades.
  const shownId = focusItem ? (focusItem.deckId ?? focusItem.id) : null;
  const lastSwitch = useRef<{ id: string | null; at: number; quick: boolean }>({ id: null, at: 0, quick: true });
  if (shownId !== lastSwitch.current.id) {
    const now = Date.now();
    lastSwitch.current = { id: shownId, at: now, quick: now - lastSwitch.current.at < 300 };
  }
  const arrive = canSteer || lastSwitch.current.quick ? "" : " arrive";
  const holdLeft = holdUntil ? Math.max(0, Math.ceil((holdUntil - Date.now()) / 1000)) : null;

  // Slides of the deck in focus, in order, so the host can flip with arrows.
  const deckSlides = focusItem?.deckId ? state.items.filter((i) => i.deckId === focusItem.deckId) : [];
  const deck = focusItem?.deckId ? state.decks.find((d) => d.id === focusItem.deckId) : undefined;
  const slideIdx = deckSlides.findIndex((i) => i.id === focusItem?.id);
  // Several quick presses should move several slides, even before the server
  // has echoed the first one back, so count from the slide last asked for.
  const asked = useRef<{ id: string; at: number } | null>(null);
  const flip = (delta: number) => {
    const from = asked.current && Date.now() - asked.current.at < 1500 ? asked.current.id : focusItem?.id;
    const next = deckSlides[deckSlides.findIndex((i) => i.id === from) + delta];
    if (!next) return;
    asked.current = { id: next.id, at: Date.now() };
    send({ type: "focus", itemId: next.id });
  };
  const flipRef = useRef(flip);
  flipRef.current = flip;
  const presenting = canSteer && Boolean(focusItem?.deckId) && !localScreen && !remoteScreen;
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) flipRef.current(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) flipRef.current(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting]);

  // Snaps are taken from the Stand bar only: the Mac app's, or the pop-out bar in a browser,
  // which snaps the shared screen through here. Saves the frame as shared; cropping waits for
  // the gallery so nobody is pulled out of the talk.
  const screenRef = useRef<HTMLDivElement>(null);
  const showingScreen = Boolean(localScreen || remoteScreen);
  const deckUp = Boolean(focusItem?.deckId && (focusItem.slideNo || focusItem.slide));
  const [flash, setFlash] = useState(0);
  const [cropId, setCropId] = useState<string | null>(null);
  // Snaps you've expanded, each a tab on the main screen beside the screen itself, and the
  // one you're on (null: the main screen, "board": the board over a share or deck). Yours
  // alone: nobody else's screen changes.
  const [tabs, setTabs] = useState<string[]>([]);
  const [ownTab, setTab] = useState<string | null>(null);
  // A share or a deck has the middle, so the board waits behind a tab of its own.
  const middleTaken = showingScreen || Boolean(sharer) || deckUp;
  // Everyone's middle screen follows the host's: the board's tab, and a chapter they open on the bar.
  // Opening anything yourself goes your own way, until Follow, or until the host comes to where you are.
  const hostView = state.hostView ?? null;
  const [own, setOwn] = useState(false);
  const following = !canSteer && !!host && !own;
  const tab = following ? (hostView?.tab === "board" ? "board" : null) : ownTab;
  const pickTab = (t: string | null) => {
    setTab(t);
    if (following) setOwn(true);
  };
  // What this screen's board has open on its bar (null: live), as it last said.
  const [myRewind, setMyRewind] = useState<Rewind | null>(null);
  const myView: HostView = { tab: middleTaken && tab === "board" ? "board" : "main", rewind: myRewind };
  const sameView = (a: HostView | null, b: HostView) => (a?.tab ?? "main") === b.tab && JSON.stringify(a?.rewind ?? null) === JSON.stringify(b.rewind);
  const hostKey = JSON.stringify(hostView);
  useEffect(() => {
    if (own && sameView(hostView, myView)) setOwn(false);
  }, [hostKey]);
  const myKey = JSON.stringify(myView);
  useEffect(() => {
    if (canSteer && !props.offline) send({ type: "host.view", view: myView });
  }, [canSteer, myKey, props.offline]);
  const boardOpen = middleTaken && tab === "board";
  // Once the middle is free the board is the main screen again; the next share opens on itself.
  useEffect(() => {
    if (!middleTaken) setTab((t) => (t === "board" ? null : t));
  }, [middleTaken]);
  const crop = (id: string) => ({ label: "Crop", run: () => setCropId(id) });
  const itemsRef = useRef(state.items);
  itemsRef.current = state.items;
  const labelOf = (itemId: string | null) => {
    const it = itemId ? itemsRef.current.find((i) => i.id === itemId) : null;
    return it ? (keyOf(it) ?? it.title) : "General";
  };
  /** Says it's saving at once, then where it landed; a failed upload keeps the picture for Try again. */
  const saving = async (work: () => Promise<Snapped>, verb: string): Promise<boolean> => {
    const wait = toast({ text: "Saving snap…", ms: 100_000 });
    try {
      const r = await work();
      toast({ text: `${verb} to ${labelOf(r.itemId)}`, action: crop(r.id) });
      return true;
    } catch (err) {
      toast(
        err instanceof SnapNotSaved
          ? // Up until it's closed: the picture is only kept for as long as the message is.
            { tone: "error", text: err.message, ms: 30 * 60_000, action: { label: "Try again", run: () => void saving(err.retry, verb) } }
          : { tone: "error", text: String((err as Error).message ?? err) },
      );
      return false;
    } finally {
      dismissToast(wait);
    }
  };
  const snap = async () => {
    const video = screenRef.current?.querySelector("video");
    if (!video) return false;
    setFlash((f) => f + 1);
    return saving(() => takeSnap(video, state.roomId), "Snapped");
  };
  // A snap from the Mac toolbar saving while Stand is in front: say so here, as the bar would.
  useEffect(() => {
    let wait: number | null = null;
    const off = macApp?.onCommand?.((c) => {
      if (c === "saving" && wait === null) wait = toast({ text: "Saving snap…", ms: 100_000 });
      if (c === "saved" && wait !== null) {
        dismissToast(wait);
        wait = null;
      }
    });
    return () => {
      off?.();
      if (wait !== null) dismissToast(wait);
    };
  }, []);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useEffect(() => {
    if (props.snapRef) props.snapRef.current = showingScreen ? () => snapRef.current() : null;
  });
  // Tell whoever is sharing when someone else snaps their screen; they can take it back.
  const seenSnaps = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(state.snaps.map((s) => s.id));
    if (seenSnaps.current) {
      for (const s of state.snaps) {
        if (seenSnaps.current.has(s.id) || s.source !== "person") continue;
        if (s.sharerId === props.participantId && s.takenById !== props.participantId)
          toast({
            text: `${s.takenBy.split(" ")[0]} snapped your screen`,
            action: { label: "Delete", run: () => removeSnap(s.id) },
          });
      }
    }
    // Every snap seen so far, so one brought back with Undo isn't news again.
    seenSnaps.current = new Set([...(seenSnaps.current ?? []), ...ids]);
  }, [state.snaps, props.participantId]);
  const cropSnap = cropId ? state.snaps.find((s) => s.id === cropId) : undefined;
  const tabSnaps = tabs.map((id) => state.snaps.find((s) => s.id === id)).filter((s): s is Snap => Boolean(s));
  const openSnap = tab ? tabSnaps.find((s) => s.id === tab) : undefined;
  const openTab = (id: string) => {
    setTabs((t) => (t.includes(id) ? t : [...t, id].slice(-6)));
    pickTab(id);
  };
  const closeTab = (id: string) => {
    setTabs((t) => t.filter((x) => x !== id));
    setTab((t) => (t === id ? null : t));
  };
  const mainLabel = localScreen ? "Your screen" : sharer ? `${sharer.name.split(" ")[0]}'s screen` : deckUp ? "Slides" : "Main screen";
  // The latest snap, small in the corner of everyone's middle screen. Each person can expand
  // it for themselves; the host or whoever took it can take it down for everyone.
  const stageSnap = state.stageSnapId ? state.snaps.find((s) => s.id === state.stageSnapId) : undefined;
  const onStage = stageSnap && {
    snap: stageSnap,
    me: props.participantId,
    canClose: canSteer || stageSnap.takenById === props.participantId,
    onOpen: () => openTab(stageSnap.id),
    onClose: () => send({ type: "stage.snap.close" }),
  };

  // The board: the middle screen, or a tab of its own while a share or a deck has it.
  const board = (
    <TopicBoard
      board={props.board}
      segments={props.segments}
      interims={interims}
      participants={state.participants}
      items={state.items}
      focusItem={focusItem}
      focusItemId={state.focusItemId}
      meetingStartedAt={state.meetingStartedAt}
      onAcceptMove={props.offline ? undefined : (title) => send({ type: "board.accept", title })}
      notes={props.list ?? props.notes}
      followUps={state.followUps}
      agent={
        props.agentCards && !props.ending && !props.offline
          ? {
              cards: props.agentCards,
              onFind: (noteId) => send({ type: "agent.options", noteId }),
              onPick: (cardId, index, as) => send({ type: "agent.pick", cardId, index, as }),
              onDismiss: (cardId) => send({ type: "agent.dismiss", cardId }),
              onTodo: (cardId) => send({ type: "agent.todo", cardId }),
            }
          : props.agentCards?.length
            ? { cards: props.agentCards }
            : undefined
      }
      onDone={props.ending ? undefined : (noteId, done) => send({ type: "followup.done", noteId, done })}
      onRemove={canSteer && !props.ending ? removeNote : undefined}
      onConfirm={props.ending || props.offline ? undefined : (noteId) => send({ type: "list.confirm", noteId })}
      onNotYet={props.ending || props.offline ? undefined : (noteId) => send({ type: "list.dismiss", noteId })}
      checkIn={state.checkIn}
      doneDeck={state.doneDeck}
      follow={following ? { rewind: hostView?.rewind ?? null, host: host!.name } : null}
      onOwn={() => setOwn(true)}
      onRewind={setMyRewind}
      checkInActs={
        props.ending || props.offline
          ? null
          : {
              onState: (noteId, st, still) => send({ type: "task.state", noteId, state: st, still }),
              onUndoSaid: (noteId) => send({ type: "task.saidDone.undo", noteId }),
              onClose: () => send({ type: "checkin", open: false }),
              onOpen: (page) => send({ type: "checkin", open: true, page }),
              onPage: (page) => send({ type: "checkin.page", page }),
            }
      }
    />
  );

  return (
    <main className="stage">
      <div className="now">
        <span className="now-label">Now discussing</span>
        <span className="now-title" dir="auto" title={focusItem ? [keyOf(focusItem), focusItem.title].filter(Boolean).join(" · ") : undefined}>
          {keyOf(focusItem) && <span className="key">{keyOf(focusItem)}</span>}
          {focusItem ? focusItem.title : "General / off-agenda"}
        </span>
        {state.pinnedBy && (
          <span className="badge pinned-badge">
            📌 Pinned
            {canSteer && (
              <button className="link" onClick={() => send({ type: "unpin" })} disabled={props.offline} title="Let the agent follow the screen again">
                Unpin
              </button>
            )}
          </span>
        )}
        {(tabSnaps.length > 0 || middleTaken) && (
          <span className="stage-tabs" role="tablist" aria-label="Main screen, the board and the snaps you opened">
            <button
              role="tab"
              aria-selected={!openSnap && !boardOpen}
              className={openSnap || boardOpen ? "stage-tab" : "stage-tab on"}
              onClick={() => pickTab(null)}
            >
              {mainLabel}
            </button>
            {middleTaken && (
              <button
                role="tab"
                aria-selected={boardOpen}
                className={boardOpen ? "stage-tab on" : "stage-tab"}
                onClick={() => pickTab("board")}
                title="The board, just for you; the share keeps going"
              >
                Board
                {!boardOpen && <AgentTabMark cards={props.agentCards} />}
              </button>
            )}
            {tabSnaps.map((s) => (
              <span key={s.id} className={s === openSnap ? "stage-tab snap on" : "stage-tab snap"} title={s.caption ?? undefined}>
                <button role="tab" aria-selected={s === openSnap} onClick={() => pickTab(s.id)}>
                  <CameraIcon />
                  {snapLabel(s, props.participantId)}
                </button>
                <button className="stage-tab-x" onClick={() => closeTab(s.id)} title="Close this tab" aria-label="Close this tab">
                  ✕
                </button>
              </span>
            ))}
          </span>
        )}
        {host ? (
          <>
            {/* Looking on your own while the host shows something else: one click back to their screen. */}
            {!canSteer && own && !sameView(hostView, myView) ? (
              <button key={hostKey} type="button" className="follow-host" onClick={() => setOwn(false)} title={`${host.name} is hosting: see what they see`}>
                Follow {host.name.split(" ")[0]} →
              </button>
            ) : (
              <span className="host-note muted small">{canSteer ? "You're the host" : `${host.name} is hosting`}</span>
            )}
          </>
        ) : (
          state.hostAway && (
            <span
              className="host-note muted small"
              title={holdLeft !== null ? `If ${state.hostAway} isn't back in ${holdLeft} seconds, hosting passes to the next person.` : undefined}
            >
              {state.hostAway} is reconnecting{holdLeft !== null ? ` · ${holdLeft} s` : "…"}
              {!props.ending && (
                <button
                  className="link"
                  onClick={() => send({ type: "host.give", participantId: props.participantId })}
                  disabled={props.offline}
                  title="Host now: you choose the item everyone talks about"
                >
                  Take over
                </button>
              )}
            </span>
          )
        )}
      </div>

      <div className="screen" ref={screenRef}>
        <div className="nudges">
        {/* A quiet nudge for the host only: their click is what moves the meeting. */}
        {canSteer && !props.ending && suggested && state.suggestion && (
          <div className="nudge" role="status" title={state.suggestion.reason}>
            <span className="agent-mark" aria-hidden>
              ✦
            </span>
            <span className="nudge-text">
              {state.suggestion.source === "talk" ? "Sounds like " : sharer && sharer.id !== props.participantId ? "The shared screen shows " : "Your screen shows "}
              <strong>
                {keyOf(suggested) ? `${keyOf(suggested)} · ` : ""}
                {suggested.title}
              </strong>
            </span>
            <button
              className="link"
              onClick={accept}
              disabled={props.offline}
              title={
                props.offline
                  ? "You can switch once Stand reconnects"
                  : moving
                    ? "Opens it for everyone and files what was said since then under it"
                    : undefined
              }
            >
              {moving ? `Switch and move ${moving} remark${moving === 1 ? "" : "s"}` : "Switch to it"}
            </button>
            <button className="link muted" onClick={() => send({ type: "suggestion.dismiss" })} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
        {!props.ending && <ConxtNudges cards={state.conxt ?? []} me={props.participantId} offline={props.offline} send={send} />}
        {/* A share or a deck has the middle: the topic stays in view as one line over it. */}
        {middleTaken && !boardOpen && !openSnap && (
          <BoardStrip board={props.board} focusItemId={state.focusItemId} onOpen={() => pickTab("board")} />
        )}
        </div>
        {flash > 0 && <div key={flash} className="snap-flash" aria-hidden />}
        {cropSnap && (
          <SnapGallery snaps={[cropSnap]} me={props.participantId} isHost={canSteer} startCrop onClose={() => setCropId(null)} />
        )}
        {/* Whatever is on the middle screen keeps it; the snap sits on top in the corner. */}
        {onStage && onStage.snap !== openSnap && <StageSnap key={onStage.snap.id} {...onStage} />}
        {/* A snap's tab covers the main screen, which keeps running underneath (a share stays live). */}
        {openSnap && <SnapTab snap={openSnap} me={props.participantId} />}
        {/* So does the board's, over a share or a deck. */}
        {boardOpen && !openSnap && (
          <div className="board-tab" role="tabpanel">
            {board}
          </div>
        )}
        {localScreen ? (
          <Video
            stream={localScreen}
            label={`You're sharing your screen${macApp ? ` · ${SNAP_KEYS_WORDS} snaps it` : ""}${canSteer ? "" : " · The agent reads only the host's screen"}`}
          />
        ) : remoteScreen ? (
          <RemoteVideo
            screen={remoteScreen}
            label={`${state.participants.find((p) => p.id === remoteScreen.participantId)?.name ?? "Someone"}'s screen${
              host && remoteScreen.participantId !== host.id ? " · The agent reads only the host's screen" : ""
            }`}
          />
        ) : sharer && !props.livekit ? (
          <div className="screen-empty">
            <p>
              <strong>{sharer.name}</strong> is sharing. In mock mode only they can see it
              {sharer.isHost ? "; the agent still reads it." : ". The agent follows only the host's screen."}
            </p>
          </div>
        ) : focusItem?.deckId && (focusItem.slideNo || focusItem.slide) ? (
          <div className="screen-empty">
            <div key={focusItem.deckId} className={`slide-stage${arrive}`}>
              <Slide item={focusItem} deck={deck} className="slide-main" />
              <div className="slide-bar">
                {canSteer && (
                  <button
                    className="ghost"
                    onClick={() => flip(-1)}
                    disabled={props.offline || slideIdx <= 0}
                    title={props.offline ? "You can flip slides once Stand reconnects" : undefined}
                    aria-label="Previous slide"
                  >
                    ←
                  </button>
                )}
                <span className="muted small">
                  {deck?.title ?? "Slides"} · {focusItem.slideNo} of {deck?.pageCount ?? deckSlides.length}
                </span>
                {canSteer && (
                  <button
                    className="ghost"
                    onClick={() => flip(1)}
                    disabled={props.offline || slideIdx < 0 || slideIdx >= deckSlides.length - 1}
                    title={props.offline ? "You can flip slides once Stand reconnects" : undefined}
                    aria-label="Next slide"
                  >
                    →
                  </button>
                )}
                {canSteer && <span className="muted small slide-hint">Arrow keys flip slides</span>}
              </div>
              {canSteer && focusItem.slide?.notes && <p className="slide-notes">{focusItem.slide.notes}</p>}
            </div>
          </div>
        ) : (
          board
        )}
      </div>

    </main>
  );
}

export function Avatar({ id, name, picture, size = 44 }: { id: string; name: string; picture?: string | null; size?: number }) {
  return picture ? (
    <img className="avatar" src={picture} alt="" width={size} height={size} referrerPolicy="no-referrer" />
  ) : (
    <div className="avatar" style={{ background: colorFor(id), width: size, height: size, fontSize: Math.max(11, size * 0.36) }}>
      {initials(name)}
    </div>
  );
}

/** "Joe 2:44": who took a snap and when, for its tab. */
function snapLabel(snap: Snap, me: string) {
  const who = snap.takenById === me ? "You" : snap.takenBy.split(" ")[0];
  return `${who} ${new Date(snap.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "")}`;
}

/** A snap in its own tab: big on the main screen, with who took it and the agent's caption. */
function SnapTab({ snap, me }: { snap: Snap; me: string }) {
  const who = snap.takenById === me ? "You" : snap.takenBy.split(" ")[0];
  return (
    <figure className="snap-tab" role="tabpanel">
      <img src={snap.url} alt={snap.caption ?? `${who} snapped this`} />
      <figcaption>
        <CameraIcon />
        <span className="stage-snap-who">
          {who} snapped this at {new Date(snap.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </span>
        {snap.caption && (
          <span className="stage-snap-cap" title={snap.caption}>
            <span className="agent-mark">✦</span> {snap.caption}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** The latest snap, small in the top right corner of the middle screen: the picture, who
 *  took it and the agent's caption. Expand (or a click on it) opens it in a tab of its own,
 *  for you only; ✕ takes it off everyone's screen, and it stays on the item. */
function StageSnap(props: { snap: Snap; me: string; canClose: boolean; onOpen: () => void; onClose: () => void }) {
  const { snap } = props;
  const who = snap.takenById === props.me ? "You" : snap.takenBy.split(" ")[0];
  return (
    <figure className="stage-snap">
      <button className="stage-snap-img" onClick={props.onOpen} title="Expand">
        <img src={snap.url} alt={snap.caption ?? `${who} snapped this`} />
      </button>
      <figcaption title={snap.caption ?? undefined}>
        <CameraIcon />
        <span className="stage-snap-who">{who}</span>
        {snap.caption && (
          <span className="stage-snap-cap">
            <span className="agent-mark">✦</span> {snap.caption}
          </span>
        )}
      </figcaption>
      <span className="stage-snap-tools">
        <button onClick={props.onOpen} title="Open it in a tab, just for you" aria-label="Expand the snap">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
          </svg>
        </button>
        {props.canClose && (
          <button onClick={props.onClose} title="Take it off everyone's screen. It stays on the item." aria-label="Take the snap off the screen">
            ✕
          </button>
        )}
      </span>
    </figure>
  );
}

function Video({ stream, label }: { stream: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <figure className="video">
      <video ref={ref} autoPlay muted playsInline />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function RemoteVideo({ screen, label }: { screen: RemoteScreen; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    screen.track.attach(el);
    return () => {
      screen.track.detach(el);
    };
  }, [screen.track]);
  return (
    <figure className="video">
      <video ref={ref} autoPlay muted playsInline />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** What the connected Conxt project raises while these people are here: a decision
 *  waiting on someone in the room, which only they can confirm, and a word people
 *  use two ways that was just said again. Hiding one is yours alone. */
function ConxtNudges(props: { cards: ConxtLive[]; me: string; offline?: boolean; send: (m: ClientMessage) => boolean }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 8000);
    return () => clearTimeout(t);
  }, [confirming]);
  // An explore session can be held and come back at once, so the id alone is not a key.
  const cardKey = (c: ConxtLive) => `${c.kind}:${c.id}`;
  const cards = props.cards.filter((c) => !hidden.includes(cardKey(c)));
  if (!cards.length) return null;
  return (
    <>
      {cards.map((c) => {
        const mine = c.here.some((p) => p.participantId === props.me);
        const who = mine ? "you" : c.here.map((p) => p.name).join(" and ");
        const lead =
          c.kind === "confirmation"
            ? `Conxt: waiting on ${who} · `
            : c.kind === "divergence"
              ? `Conxt: “${c.term}” is used two ways · `
              : c.kind === "exploring"
                ? "Conxt: explore work · "
                : "Conxt: came back · ";
        return (
          <div key={cardKey(c)} className="nudge conxt" role="status" title={c.why}>
            <span className="agent-mark" aria-hidden>
              ✦
            </span>
            <span className="nudge-text">
              {lead}
              <strong>{c.title}</strong>
            </span>
            {c.kind === "exploring" && mine && (
              <button
                className="link"
                disabled={props.offline || confirming === cardKey(c)}
                title={props.offline ? "You can share once Stand reconnects" : "Send what your agent explored to the team's review in Conxt"}
                onClick={() => props.send({ type: "conxt.share", itemId: c.id }) && setConfirming(cardKey(c))}
              >
                {confirming === cardKey(c) ? "Sharing…" : "Share now"}
              </button>
            )}
            {c.kind === "confirmation" && mine && (
              <button
                className="link"
                disabled={props.offline || confirming === cardKey(c)}
                title={props.offline ? "You can confirm once Stand reconnects" : "Agree to this decision in Conxt, as yourself"}
                onClick={() => props.send({ type: "conxt.confirm", itemId: c.id }) && setConfirming(cardKey(c))}
              >
                {confirming === cardKey(c) ? "Confirming…" : "Confirm"}
              </button>
            )}
            <button className="link muted" onClick={() => setHidden((h) => [...h, cardKey(c)])} aria-label="Hide">
              ✕
            </button>
          </div>
        );
      })}
    </>
  );
}

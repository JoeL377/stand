import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Item, Participant, RoomState, Snap } from "../../shared/protocol.ts";
import type { RemoteScreen } from "./useMedia.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, initials, keyOf } from "../util.ts";
import { Slide } from "../slides.tsx";
import { CameraIcon, ShareIcon } from "../icons.tsx";
import { SnapGallery, addImageSnap, deleteSnap, takeSnap } from "../Snaps.tsx";

type Toast = { key: number; text: string; snapId?: string; action?: "crop" | "delete" };

/** Snap's shortcut, the same as the Mac app's: a bare letter would fire while people type. */
const SNAP_KEYS = /Mac/.test(navigator.platform) ? "⌃⇧S" : "Ctrl+Shift+S";
/** Stand for Mac, when the page runs inside it: its snap toolbar (screen, window or part of it).
 *  snap() resolves to what to tell the person once the snap is done, or nothing if they cancelled. */
type SnapReport = { title: string; body: string; snapId?: string } | null | undefined;
const macApp = (window as { standApp?: { snap(): Promise<SnapReport> } }).standApp;

export function Stage(props: {
  state: RoomState;
  me: Participant | undefined;
  focusItem: Item | null;
  canSteer: boolean;
  participantId: string;
  send: (m: ClientMessage) => void;
  localScreen: MediaStream | null;
  remoteScreen: RemoteScreen | null;
  speaking: Set<string>;
  interims: Record<string, Interim>;
  livekit: boolean;
}) {
  const { state, focusItem, canSteer, send, localScreen, remoteScreen, speaking, interims } = props;
  const suggested = state.suggestion ? state.items.find((i) => i.id === state.suggestion!.itemId) : null;
  const sharer = state.participants.find((p) => p.isSharing);
  const host = state.participants.find((p) => p.isHost);

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

  // Snap: the camera on the shared screen, or ⌃⇧S. Saves the frame as shared;
  // cropping waits for the gallery so nobody is pulled out of the talk.
  const screenRef = useRef<HTMLDivElement>(null);
  const showingScreen = Boolean(localScreen || remoteScreen);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flash, setFlash] = useState(0);
  const [cropId, setCropId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const toast = (t: Omit<Toast, "key">, ms = 5000) => {
    const key = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { ...t, key }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.key !== key)), ms);
  };
  const snap = async () => {
    const video = screenRef.current?.querySelector("video");
    if (!video) return;
    setFlash((f) => f + 1);
    try {
      const id = await takeSnap(video, state.roomId);
      toast({ text: "Snapped", snapId: id, action: "crop" });
    } catch (err) {
      toast({ text: String((err as Error).message ?? err) });
    }
  };
  // The Mac app's toolbar. Whatever comes of it, including why it couldn't, shows here.
  const snapInApp = async () => {
    try {
      const r = await macApp?.snap();
      const text = r && `${r.title}. ${r.body}`;
      // Long ones say what to fix (a permission, say), so they stay up long enough to read.
      if (text) toast({ text, ...(r.snapId ? { snapId: r.snapId, action: "crop" as const } : {}) }, Math.max(5000, text.length * 60));
    } catch {
      toast({ text: "Quit the Stand app and open it again to use Snap." });
    }
  };
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useEffect(() => {
    if (!showingScreen) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey || e.code !== "KeyS" || e.repeat || t.closest("[role=dialog]")) return;
      e.preventDefault();
      void snapRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showingScreen]);
  // Paste or drop a screenshot of your own: it's kept on the item in focus, like a snap.
  const [dropping, setDropping] = useState(false);
  const focusLabel = focusItem ? (keyOf(focusItem) ?? focusItem.title) : "General";
  const addImages = async (files: File[]) => {
    for (const f of files.slice(0, 5)) {
      try {
        const id = await addImageSnap(f, state.roomId);
        toast({ text: `Added to ${focusLabel}`, snapId: id, action: "crop" });
      } catch (err) {
        toast({ text: String((err as Error).message ?? err) });
      }
    }
  };
  const addRef = useRef(addImages);
  addRef.current = addImages;
  useEffect(() => {
    const imagesIn = (dt: DataTransfer | null) => [...(dt?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    const carriesImage = (dt: DataTransfer | null) => [...(dt?.items ?? [])].some((i) => i.kind === "file" && i.type.startsWith("image/"));
    const onPaste = (e: ClipboardEvent) => {
      const files = imagesIn(e.clipboardData);
      if (!files.length) return;
      // Pasting into a text box with text on the clipboard pastes the text, as usual.
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]") && e.clipboardData?.types.includes("text/plain")) return;
      e.preventDefault();
      void addRef.current(files);
    };
    let leave: ReturnType<typeof setTimeout> | undefined;
    const onOver = (e: DragEvent) => {
      if (!carriesImage(e.dataTransfer)) return;
      e.preventDefault();
      setDropping(true);
      clearTimeout(leave);
      leave = setTimeout(() => setDropping(false), 250);
    };
    const onDrop = (e: DragEvent) => {
      const files = imagesIn(e.dataTransfer);
      setDropping(false);
      if (!files.length) return;
      e.preventDefault();
      void addRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      clearTimeout(leave);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  // Tell whoever is sharing when someone else snaps their screen; they can take it back.
  const seenSnaps = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(state.snaps.map((s) => s.id));
    if (seenSnaps.current) {
      for (const s of state.snaps) {
        if (seenSnaps.current.has(s.id) || s.source !== "person") continue;
        if (s.sharerId === props.participantId && s.takenById !== props.participantId)
          toast({ text: `${s.takenBy.split(" ")[0]} snapped your screen`, snapId: s.id, action: "delete" });
      }
    }
    seenSnaps.current = ids;
  }, [state.snaps, props.participantId]);
  const cropSnap = cropId ? state.snaps.find((s) => s.id === cropId) : undefined;
  const viewSnap = viewId ? state.snaps.find((s) => s.id === viewId) : undefined;
  // The snap on everyone's middle screen. The host or whoever took it can take it down.
  const stageSnap = state.stageSnapId ? state.snaps.find((s) => s.id === state.stageSnapId) : undefined;
  const onStage = stageSnap && {
    snap: stageSnap,
    me: props.participantId,
    canClose: canSteer || stageSnap.takenById === props.participantId,
    onOpen: () => setViewId(stageSnap.id),
    onClose: () => send({ type: "stage.snap.close" }),
  };

  // Demo speakers and remote talkers who aren't connected still show while talking.
  const talkingIds = new Set([...speaking, ...Object.keys(interims)]);
  const ghosts = Object.values(interims).filter((i) => !state.participants.some((p) => p.id === i.speakerId));

  return (
    <main className="stage">
      <div className="now">
        <span className="now-label">Now discussing</span>
        <span className="now-title">
          {keyOf(focusItem) && <span className="key">{keyOf(focusItem)}</span>}
          {focusItem ? focusItem.title : "General / off-agenda"}
        </span>
        {state.pinnedBy && <span className="badge">📌 Pinned</span>}
        {host && (
          <span className="host-note muted small">{canSteer ? "You're the host" : `${host.name} is hosting`}</span>
        )}
      </div>

      {/* A quiet nudge for the host only: their click is what moves the meeting. */}
      {canSteer && suggested && state.suggestion && (
        <div className="nudge" role="status" title={state.suggestion.reason}>
          <span className="agent-mark" aria-hidden>
            ✦
          </span>
          <span className="nudge-text">
            Your screen shows{" "}
            <strong>
              {keyOf(suggested) ? `${keyOf(suggested)} · ` : ""}
              {suggested.title}
            </strong>
          </span>
          <button className="link" onClick={() => send({ type: "suggestion.accept" })}>
            Switch to it
          </button>
          <button className="link muted" onClick={() => send({ type: "suggestion.dismiss" })} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="screen" ref={screenRef}>
        {macApp ? (
          <button className="app-snap" title={`Snap the screen, a window or part of it (${SNAP_KEYS})`} onClick={() => void snapInApp()}>
            <CameraIcon />
            Snap
          </button>
        ) : (
          showingScreen && (
            <button className="snap-btn" title={`Snap this screen (${SNAP_KEYS})`} aria-label="Snap this screen" onClick={() => void snap()}>
              <CameraIcon />
            </button>
          )
        )}
        {flash > 0 && <div key={flash} className="snap-flash" aria-hidden />}
        {dropping && (
          <div className="shot-drop" aria-hidden>
            Drop to add it to {focusLabel}
          </div>
        )}
        {toasts.length > 0 && (
          <div className="snap-toasts" role="status">
            {toasts.map((t) => (
              <div key={t.key} className="snap-toast">
                <span>{t.text}</span>
                {t.snapId && t.action === "crop" && (
                  <button className="link" onClick={() => setCropId(t.snapId!)}>
                    Crop
                  </button>
                )}
                {t.snapId && t.action === "delete" && (
                  <button
                    className="link"
                    onClick={() => {
                      void deleteSnap(t.snapId!);
                      setToasts((ts) => ts.filter((x) => x.key !== t.key));
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {cropSnap && (
          <SnapGallery snaps={[cropSnap]} me={props.participantId} isHost={canSteer} startCrop onClose={() => setCropId(null)} />
        )}
        {viewSnap && <SnapGallery snaps={[viewSnap]} me={props.participantId} isHost={canSteer} onClose={() => setViewId(null)} />}
        {/* While a screen is shared, the share keeps the middle and the snap waits in the corner. */}
        {onStage && showingScreen && <StageSnap {...onStage} small />}
        {localScreen ? (
          <Video stream={localScreen} label="You're sharing your screen" />
        ) : remoteScreen ? (
          <RemoteVideo screen={remoteScreen} label={`${state.participants.find((p) => p.id === remoteScreen.participantId)?.name ?? "Someone"}'s screen`} />
        ) : onStage ? (
          <StageSnap {...onStage} />
        ) : sharer && !props.livekit ? (
          <div className="screen-empty">
            <p>
              <strong>{sharer.name}</strong> is sharing. In mock mode only they can see it; the agent still reads it.
            </p>
          </div>
        ) : (
          <div className="screen-empty">
            {focusItem?.deckId && (focusItem.slideNo || focusItem.slide) ? (
              <div className="slide-stage">
                <Slide item={focusItem} deck={deck} className="slide-main" />
                <div className="slide-bar">
                  {canSteer && (
                    <button className="ghost" onClick={() => flip(-1)} disabled={slideIdx <= 0} aria-label="Previous slide">
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
                      disabled={slideIdx < 0 || slideIdx >= deckSlides.length - 1}
                      aria-label="Next slide"
                    >
                      →
                    </button>
                  )}
                  {canSteer && <span className="muted small slide-hint">Arrow keys flip slides</span>}
                </div>
                {canSteer && focusItem.slide?.notes && <p className="slide-notes">{focusItem.slide.notes}</p>}
              </div>
            ) : focusItem ? (
              <div className="focus-card">
                {keyOf(focusItem) && <div className="key big">{keyOf(focusItem)}</div>}
                <h2>{focusItem.title}</h2>
                {focusItem.description && <p className="muted pre focus-desc">{focusItem.description}</p>}
                {focusItem.url && (
                  <a href={focusItem.url} target="_blank" rel="noreferrer">
                    Open in {focusItem.source === "linear" ? "Linear" : "new tab"} ↗
                  </a>
                )}
              </div>
            ) : (
              <p className="muted">
                {canSteer ? "Open an item on the left, or share your screen." : `Waiting for ${host?.name ?? "the host"} to open an item.`}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="people">
        {state.participants.map((p) => (
          <Person
            key={p.id}
            id={p.id}
            name={p.name}
            picture={p.picture}
            talking={talkingIds.has(p.id)}
            tag={p.isHost ? "Host" : undefined}
            sharing={p.isSharing}
            onMakeHost={canSteer && p.id !== props.participantId ? () => send({ type: "host.give", participantId: p.id }) : undefined}
          />
        ))}
        {ghosts.map((g) => (
          <Person key={g.speakerId} id={g.speakerId} name={g.speakerName} talking tag="Demo" />
        ))}
      </div>
    </main>
  );
}

function Person(props: {
  id: string;
  name: string;
  picture?: string | null;
  talking: boolean;
  tag?: string;
  sharing?: boolean;
  onMakeHost?: () => void;
}) {
  const { id, name, picture, talking, tag, sharing, onMakeHost } = props;
  return (
    <div className={talking ? "person talking" : "person"}>
      <Avatar id={id} name={name} picture={picture} />
      <div className="person-label">
        <span className="person-name">{name}</span>
        {(tag || sharing) && (
          <span className="person-tag">
            {tag}
            {sharing && (
              <span title={`${name} is sharing their screen`} aria-label="sharing" role="img">
                <ShareIcon />
              </span>
            )}
          </span>
        )}
      </div>
      {onMakeHost && (
        <button className="link person-action" onClick={onMakeHost} title={`Let ${name} drive the meeting`}>
          Make host
        </button>
      )}
    </div>
  );
}

export function Avatar({ id, name, picture, size = 44 }: { id: string; name: string; picture?: string | null; size?: number }) {
  return picture ? (
    <img className="avatar" src={picture} alt="" width={size} height={size} referrerPolicy="no-referrer" />
  ) : (
    <div className="avatar" style={{ background: colorFor(id), width: size, height: size, fontSize: size * 0.36 }}>
      {initials(name)}
    </div>
  );
}

/** A snap on the middle screen: the picture, who took it and the agent's caption. Clicking
 *  it opens it full size; ✕ takes it off everyone's screen, and it stays on the item. */
function StageSnap(props: { snap: Snap; me: string; canClose: boolean; small?: boolean; onOpen: () => void; onClose: () => void }) {
  const { snap } = props;
  const who = snap.takenById === props.me ? "You" : snap.takenBy.split(" ")[0];
  return (
    <figure className={props.small ? "stage-snap small" : "stage-snap"}>
      <button className="stage-snap-img" onClick={props.onOpen} title="See it full size">
        <img src={snap.url} alt={snap.caption ?? `${who} snapped this`} />
      </button>
      {!props.small && (
        <figcaption>
          <CameraIcon />
          <span>{who} snapped this</span>
          {snap.caption && (
            <span className="stage-snap-cap" title={snap.caption}>
              <span className="agent-mark">✦</span> {snap.caption}
            </span>
          )}
        </figcaption>
      )}
      {props.canClose && (
        <button className="stage-snap-close" onClick={props.onClose} title="Take it off everyone's screen. It stays on the item." aria-label="Take the snap off the screen">
          ✕
        </button>
      )}
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

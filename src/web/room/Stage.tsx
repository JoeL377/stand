import { useEffect, useRef, useState } from "react";
import type { ClientMessage, Item, Participant, RoomState } from "../../shared/protocol.ts";
import type { RemoteScreen } from "./useMedia.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, initials, keyOf } from "../util.ts";
import { Slide } from "../slides.tsx";
import { CameraIcon, ShareIcon } from "../icons.tsx";
import { SnapGallery, deleteSnap, takeSnap } from "../Snaps.tsx";

type Toast = { key: number; text: string; snapId?: string; action?: "crop" | "delete" };

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

  // Snap: the camera on the shared screen, or S. Saves the frame as shared;
  // cropping waits for the gallery so nobody is pulled out of the talk.
  const screenRef = useRef<HTMLDivElement>(null);
  const showingScreen = Boolean(localScreen || remoteScreen);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flash, setFlash] = useState(0);
  const [cropId, setCropId] = useState<string | null>(null);
  const toast = (t: Omit<Toast, "key">) => {
    const key = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { ...t, key }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.key !== key)), 5000);
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
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useEffect(() => {
    if (!showingScreen) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable], [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key !== "s" && e.key !== "S") return;
      e.preventDefault();
      void snapRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showingScreen]);
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
        {showingScreen && (
          <button className="snap-btn" title="Snap this screen (S)" aria-label="Snap this screen" onClick={() => void snap()}>
            <CameraIcon />
          </button>
        )}
        {flash > 0 && <div key={flash} className="snap-flash" aria-hidden />}
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
        {localScreen ? (
          <Video stream={localScreen} label="You're sharing your screen" />
        ) : remoteScreen ? (
          <RemoteVideo screen={remoteScreen} label={`${state.participants.find((p) => p.id === remoteScreen.participantId)?.name ?? "Someone"}'s screen`} />
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

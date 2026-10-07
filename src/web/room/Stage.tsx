import { useEffect, useRef } from "react";
import type { ClientMessage, Item, Participant, RoomState } from "../../shared/protocol.ts";
import type { RemoteScreen } from "./useMedia.ts";
import type { Interim } from "./useRoomSocket.ts";
import { colorFor, initials } from "../util.ts";

export function Stage(props: {
  state: RoomState;
  me: Participant | undefined;
  focusItem: Item | null;
  canSteer: boolean;
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
  const presenter = state.participants.find((p) => p.isPresenter);

  // Demo speakers and remote talkers who aren't connected still show while talking.
  const talkingIds = new Set([...speaking, ...Object.keys(interims)]);
  const ghosts = Object.values(interims).filter((i) => !state.participants.some((p) => p.id === i.speakerId));

  return (
    <main className="stage">
      <div className="now">
        <span className="now-label">Now discussing</span>
        <span className="now-title">
          {focusItem?.externalId && <span className="key">{focusItem.externalId}</span>}
          {focusItem ? focusItem.title : "General / off-agenda"}
        </span>
        {state.pinnedBy && <span className="badge">📌 Pinned</span>}
      </div>

      {suggested && state.suggestion && (
        <div className="suggestion" role="status">
          <span className="agent-mark" aria-hidden>
            ✦
          </span>
          <div className="suggestion-text">
            <strong>
              Moved on to {suggested.externalId ? `${suggested.externalId} · ` : ""}
              {suggested.title}?
            </strong>
            <span className="muted small">{state.suggestion.reason}</span>
          </div>
          {canSteer ? (
            <div className="suggestion-actions">
              <button className="primary" onClick={() => send({ type: "suggestion.accept" })}>
                Switch
              </button>
              <button className="ghost" onClick={() => send({ type: "suggestion.dismiss" })}>
                Not now
              </button>
            </div>
          ) : (
            <span className="muted small">Waiting for {presenter?.name ?? "the presenter"}</span>
          )}
        </div>
      )}

      <div className="screen">
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
            {focusItem ? (
              <div className="focus-card">
                {focusItem.externalId && <div className="key big">{focusItem.externalId}</div>}
                <h2>{focusItem.title}</h2>
                {focusItem.description && <p className="muted pre">{focusItem.description.slice(0, 400)}</p>}
                {focusItem.url && (
                  <a href={focusItem.url} target="_blank" rel="noreferrer">
                    Open in {focusItem.source === "linear" ? "Linear" : "new tab"} ↗
                  </a>
                )}
              </div>
            ) : (
              <p className="muted">Share your screen, or pick an item on the left.</p>
            )}
          </div>
        )}
      </div>

      <div className="people">
        {state.participants.map((p) => (
          <Person key={p.id} id={p.id} name={p.name} talking={talkingIds.has(p.id)} tag={p.isSharing ? "Sharing" : p.isPresenter ? "Presenter" : undefined} />
        ))}
        {ghosts.map((g) => (
          <Person key={g.speakerId} id={g.speakerId} name={g.speakerName} talking tag="Demo" />
        ))}
      </div>
    </main>
  );
}

function Person({ id, name, talking, tag }: { id: string; name: string; talking: boolean; tag?: string }) {
  return (
    <div className={talking ? "person talking" : "person"}>
      <div className="avatar" style={{ background: colorFor(id) }}>
        {initials(name)}
      </div>
      <div className="person-name">{name}</div>
      {tag && <div className="person-tag">{tag}</div>}
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

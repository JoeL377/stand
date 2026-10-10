// Snaps in the app: taking one from the shared screen, the "N snaps" pill and
// its gallery, and cropping afterwards. Taking one never interrupts: it saves
// the frame as shared, and any cropping happens later in the gallery.

import { useEffect, useRef, useState } from "react";
import type { Snap } from "../shared/protocol.ts";
import { CameraIcon, CloseIcon, CropIcon, TrashIcon } from "./icons.tsx";
import { fmtTime } from "./util.ts";

/** Grabs the frame a video is showing, at the size it's shared, and uploads it. */
export async function takeSnap(video: HTMLVideoElement, roomId: string): Promise<string> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error("The shared screen isn't showing yet.");
  const at = Date.now();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't read the frame"))), "image/jpeg", 0.92),
  );
  const res = await fetch(`/api/rooms/${roomId}/snaps?at=${at}&w=${w}&h=${h}`, { method: "POST", body: blob });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save the snap");
  return ((await res.json()) as { id: string }).id;
}

export const deleteSnap = (id: string) => fetch(`/api/snaps/${id}`, { method: "DELETE" });

/** Who may crop or delete a snap: whoever took it, whoever's screen it is, and the host. */
export const canChangeSnap = (s: Snap, me: string, isHost: boolean) => isHost || s.takenById === me || s.sharerId === me;

export function SnapsPill(props: { snaps: Snap[]; me: string; isHost: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!props.snaps.length) return null;
  const n = props.snaps.length;
  return (
    <>
      <button
        className={`${props.className ?? "disc-pill"} snaps-pill`}
        onClick={() => setOpen(true)}
        title={`${n} snap${n === 1 ? "" : "s"} of the shared screen`}
        aria-label={`${n} snap${n === 1 ? "" : "s"}`}
      >
        <CameraIcon size={13} />
        {n}
      </button>
      {open && <SnapGallery snaps={props.snaps} me={props.me} isHost={props.isHost} onClose={() => setOpen(false)} />}
    </>
  );
}

export function SnapGallery(props: {
  snaps: Snap[];
  me: string;
  isHost: boolean;
  start?: number;
  startCrop?: boolean;
  onClose: () => void;
}) {
  const { snaps, onClose } = props;
  const [i, setI] = useState(props.start ?? 0);
  const [cropping, setCropping] = useState(Boolean(props.startCrop));
  const snap = snaps[Math.min(i, snaps.length - 1)];
  useEffect(() => {
    if (!snaps.length) onClose();
  }, [snaps.length, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cropping) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((x) => Math.min(x + 1, snaps.length - 1));
      else if (e.key === "ArrowLeft") setI((x) => Math.max(x - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, snaps.length, cropping]);
  if (!snap) return null;
  const mine = canChangeSnap(snap, props.me, props.isHost);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog snap-pop" role="dialog" aria-modal="true" aria-label="Snaps">
        {cropping ? (
          <CropView snap={snap} onDone={() => setCropping(false)} />
        ) : (
          <>
            <div className="snap-stage">
              <img src={snap.url} alt={snap.caption ?? "Snap of the shared screen"} />
            </div>
            <div className="snap-info">
              <div className="snap-text">
                {snap.caption && (
                  <p className="snap-caption">
                    <span className="snap-mark" aria-hidden>
                      ✦
                    </span>
                    {snap.caption}
                  </p>
                )}
                <p className="snap-meta">
                  {snap.source === "agent" ? "Kept by the agent" : snap.takenBy} · {fmtTime(snap.ts)}
                  {snap.sharerName && snap.sharerName !== snap.takenBy ? ` · ${snap.sharerName}'s screen` : ""}
                </p>
              </div>
              <div className="snap-tools">
                {mine && (
                  <>
                    <button className="icon-btn" title="Crop" onClick={() => setCropping(true)}>
                      <CropIcon size={17} />
                    </button>
                    <button className="icon-btn" title="Delete" onClick={() => void deleteSnap(snap.id)}>
                      <TrashIcon size={17} />
                    </button>
                  </>
                )}
                <button className="icon-btn" title="Close" onClick={onClose}>
                  <CloseIcon size={17} />
                </button>
              </div>
            </div>
            {snaps.length > 1 && (
              <div className="snap-thumbs">
                {snaps.map((s, k) => (
                  <button key={s.id} className={k === i ? "on" : ""} onClick={() => setI(k)} aria-label={`Snap ${k + 1}`}>
                    <img src={s.url} alt="" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Drag a box over the snap; saving replaces the image with that part of it. */
function CropView(props: { snap: Snap; onDone: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) };
  };
  const save = async () => {
    const el = img.current;
    if (!el || !box || box.w < 0.02 || box.h < 0.02) return;
    setSaving(true);
    const nw = el.naturalWidth;
    const nh = el.naturalHeight;
    const c = document.createElement("canvas");
    c.width = Math.round(box.w * nw);
    c.height = Math.round(box.h * nh);
    c.getContext("2d")!.drawImage(el, box.x * nw, box.y * nh, c.width, c.height, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.92));
    if (blob) await fetch(`/api/snaps/${props.snap.id}/image?w=${c.width}&h=${c.height}`, { method: "PUT", body: blob });
    props.onDone();
  };
  return (
    <>
      <div className="snap-stage crop">
        <div
          className="crop-area"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = at(e);
            setBox({ ...drag.current, w: 0, h: 0 });
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const p = at(e);
            const o = drag.current;
            setBox({ x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y) });
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <img ref={img} src={props.snap.url} alt="" draggable={false} />
          {box && (
            <div
              className="crop-box"
              style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
            />
          )}
        </div>
      </div>
      <div className="snap-info">
        <p className="snap-meta">Drag over the part worth keeping.</p>
        <div className="snap-tools">
          <button className="ghost small" onClick={props.onDone}>
            Cancel
          </button>
          <button className="primary small" disabled={!box || box.w < 0.02 || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save crop"}
          </button>
        </div>
      </div>
    </>
  );
}

/** Snaps as a row of thumbnails (the recap); a click opens the gallery there. */
export function SnapStrip(props: { snaps: Snap[] }) {
  const [at, setAt] = useState<number | null>(null);
  if (!props.snaps.length) return null;
  return (
    <div className="snap-strip">
      {props.snaps.map((s, k) => (
        <button key={s.id} className="snap-thumb" onClick={() => setAt(k)} title={s.caption ?? `Snap by ${s.takenBy}`}>
          <img src={s.url} alt={s.caption ?? ""} loading="lazy" />
          {s.source === "agent" && (
            <span className="snap-thumb-mark" aria-label="Kept by the agent">
              ✦
            </span>
          )}
        </button>
      ))}
      {at !== null && <SnapGallery snaps={props.snaps} me="" isHost={false} start={at} onClose={() => setAt(null)} />}
    </div>
  );
}

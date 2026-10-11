// Start talking on a space's page: what kind of meeting this is, and for an alignment meeting,
// the question. The space's meetings start as the kind picked here from then on, so one-click
// joins elsewhere (the Spaces list, the Mac bar) start the same way.
import { useEffect, useRef, useState } from "react";
import type { MeetingKind } from "../../shared/protocol.ts";
import { api, type RoomInfo } from "../api.ts";
import { MicIcon } from "../icons.tsx";
import { errorToast } from "../Toasts.tsx";
import { useDismiss } from "../useDismiss.ts";

const KINDS: Array<{ kind: MeetingKind; label: string; what: string }> = [
  { kind: "notes", label: "Notes", what: "To-dos, decisions and topics, item by item." },
  { kind: "alignment", label: "Alignment", what: "The question, where each person stands, and where you land." },
];

export function StartMeeting(props: { room: RoomInfo; onJoin: () => void }) {
  const { room } = props;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MeetingKind>(room.defaultKind ?? "notes");
  const carry = room.openAlignment;
  const [question, setQuestion] = useState(carry?.question ?? "");
  const [starting, setStarting] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open && kind === "alignment") input.current?.focus();
  }, [open, kind]);
  // The kind and the question follow the space when it changes under an open page.
  useEffect(() => {
    if (!open) {
      setKind(room.defaultKind ?? "notes");
      setQuestion(carry?.question ?? "");
    }
  }, [room.defaultKind, carry?.question, open]);
  const carried = Boolean(carry && question.trim() === carry.question);

  const start = () => {
    if (starting) return;
    setStarting(true);
    api
      .meetingSetup(room.id, { kind, question: kind === "alignment" ? question.trim() : "", carry: carried ? carry!.meetingId : null })
      .then(
        () => props.onJoin(),
        (err) => {
          setStarting(false);
          errorToast("Couldn't start the meeting")(err);
        },
      );
  };

  return (
    <span className="pop-wrap" ref={ref}>
      <button className="primary sh-join" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <MicIcon />
        Start talking
      </button>
      {open && (
        <form
          className="start-pop"
          role="dialog"
          aria-label="Start a meeting"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <span className="start-label">What kind of meeting?</span>
          <div className="start-kinds" role="radiogroup" aria-label="Kind of meeting">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? "on" : ""} onClick={() => setKind(k.kind)}>
                {k.label}
              </button>
            ))}
          </div>
          <span className="start-what">{KINDS.find((k) => k.kind === kind)!.what}</span>
          {kind === "alignment" && (
            <>
              <label className="start-label" htmlFor="start-question">
                What are we aligning on?
              </label>
              <textarea
                id="start-question"
                ref={input}
                rows={2}
                value={question}
                maxLength={300}
                placeholder="Leave empty and Stand suggests one from the talk"
                onChange={(e) => setQuestion(e.target.value.replace(/\n/g, " "))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  start();
                }}
              />
              {carried && (
                <span className="start-carry">
                  <span className="agent-mark small">✦</span> Still open from last time. Starts from where it stood
                  {carry!.positions + carry!.agreed > 0 || carry!.test ? ": " : "."}
                  {[
                    carry!.positions > 0 && `${carry!.positions} position${carry!.positions === 1 ? "" : "s"}`,
                    carry!.agreed > 0 && `${carry!.agreed} agreed`,
                    carry!.test && "1 test to settle it",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </>
          )}
          <button className="primary start-go" disabled={starting}>
            <MicIcon />
            {starting ? "Starting…" : "Start talking"}
          </button>
        </form>
      )}
    </span>
  );
}

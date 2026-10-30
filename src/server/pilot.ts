// The Pilot seat: one person at a time drives ✦ Stand in a meeting, by typing on an answer card's box or
// holding Ask Stand. Everyone else watches the card and asks to take over.
// - The seat starts free; whoever asks Stand something first takes it.
// - "Ask to pilot" puts you in line. The pilot gets Hand over / Not now. If they don't answer, the seat goes
//   to the first asker by itself after a short countdown, which never runs out within a minute of the
//   pilot's last question (or while they type), so nobody loses the seat mid-question.
// - A pilot who hasn't asked anything for a while is idle: the next ask takes the seat at once.
// - The pilot can hand the seat to anyone here or leave it; the host can take it without asking.
// - A pilot whose connection drops keeps the seat a little while, like the host does, then it moves on.
// Pure state with the clock passed in; the room runs the timers and tells everyone (room.ts).
import type { PilotView } from "../shared/protocol.ts";

/** A request hands over by itself this long after it reaches the front, if the pilot doesn't answer. */
export const PILOT_ANSWER_MS = 20_000;
/** ...but never within this long of the pilot's last question or keystroke. */
export const PILOT_RECENT_MS = 60_000;
/** No question this long: the pilot is idle, and the next request takes the seat at once. */
export const PILOT_IDLE_MS = 5 * 60_000;
/** The pilot's connection down this long: the seat moves on. */
export const PILOT_AWAY_MS = 30_000;
/** "Joe is typing" lasts this long after the last word that the pilot is. */
export const PILOT_TYPING_MS = 6_000;

type Who = { id: string; name: string };
type How = NonNullable<PilotView["last"]>["how"];

export class PilotSeat {
  private pilot: Who | null = null;
  /** The pilot's last question or keystroke. */
  private lastUse = 0;
  private queue: Array<Who & { at: number }> = [];
  /** When the first asker reached the front. */
  private frontSince = 0;
  private typingUntil = 0;
  private awaySince: number | null = null;
  private last: PilotView["last"] = null;
  private declined: PilotView["declined"] = null;

  get id() {
    return this.pilot?.id ?? null;
  }

  /** Someone asks Stand something. True when they may: they're the pilot, or the seat was free and now is theirs. */
  use(who: Who, now: number): boolean {
    if (this.pilot && this.pilot.id !== who.id) return false;
    if (!this.pilot) this.hand(who, "free", now);
    this.lastUse = now;
    this.typingUntil = 0;
    return true;
  }

  /** The pilot is typing (or stopped). Changes nothing for anyone else. */
  typing(id: string, on: boolean, now: number): boolean {
    if (this.pilot?.id !== id) return false;
    const was = this.typingUntil > now;
    this.typingUntil = on ? now + PILOT_TYPING_MS : 0;
    if (on) this.lastUse = now;
    return was !== on;
  }

  /** Ask to take over: a free, idle or abandoned seat is yours at once; otherwise you're in line. */
  request(who: Who, now: number): boolean {
    if (this.pilot?.id === who.id) return false;
    if (!this.pilot) return this.hand(who, "free", now), true;
    if (this.idle(now) || this.awaySince !== null) return this.hand(who, "asked", now), true;
    if (this.queue.some((q) => q.id === who.id)) return false;
    this.queue.push({ ...who, at: now });
    if (this.queue.length === 1) this.frontSince = now;
    if (this.declined?.id === who.id) this.declined = null;
    return true;
  }

  /** Take back a request (or leave the line on the way out). */
  cancel(id: string, now: number): boolean {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    if (i === 0) this.frontSince = now;
    return true;
  }

  /** The pilot answers the first asker: Hand over, or Not now (the next asker's countdown starts fresh). */
  answer(pilotId: string, yes: boolean, now: number): boolean {
    const front = this.queue[0];
    if (this.pilot?.id !== pilotId || !front) return false;
    if (yes) return this.hand(front, "gave", now), true;
    this.queue.shift();
    this.frontSince = now;
    this.declined = { id: front.id, by: this.pilot.name, at: now };
    return true;
  }

  /** The pilot hands the seat to someone here, or leaves it (to = null: the first asker gets it, or it's free). */
  give(pilotId: string, to: Who | null, now: number): boolean {
    if (this.pilot?.id !== pilotId || to?.id === pilotId) return false;
    const next = to ?? this.queue[0] ?? null;
    if (next) this.hand(next, "gave", now);
    else this.hand(null, "left", now);
    return true;
  }

  /** The host takes the seat without asking. */
  take(who: Who, now: number): boolean {
    if (this.pilot?.id === who.id) return false;
    this.hand(who, "took", now);
    return true;
  }

  /** Someone's last connection closed: the pilot's seat waits for them a while, an asker leaves the line. */
  left(id: string, now: number): boolean {
    const asked = this.cancel(id, now);
    if (this.pilot?.id !== id) return asked;
    this.awaySince = now;
    this.typingUntil = 0;
    return true;
  }

  /** Someone came back: the pilot's seat was waiting for them. */
  back(id: string): boolean {
    if (this.pilot?.id !== id || this.awaySince === null) return false;
    this.awaySince = null;
    return true;
  }

  /** The clock moved on: hand over when a countdown ran out or the pilot stayed away. True when something changed. */
  tick(now: number): boolean {
    let changed = false;
    if (this.typingUntil && now >= this.typingUntil) {
      this.typingUntil = 0;
      changed = true;
    }
    if (this.pilot && this.awaySince !== null && now - this.awaySince >= PILOT_AWAY_MS) {
      this.hand(this.queue[0] ?? null, this.queue[0] ? "auto" : "left", now);
      return true;
    }
    const at = this.handAt();
    if (at !== null && now >= at) {
      this.hand(this.queue[0], "auto", now);
      return true;
    }
    return changed;
  }

  /** The next moment tick() has something to do, or the idle mark to show. */
  nextAt(now: number): number | null {
    const times = [this.handAt(), this.typingUntil || null, this.awaySince !== null ? this.awaySince + PILOT_AWAY_MS : null, this.pilot && !this.idle(now) ? this.lastUse + PILOT_IDLE_MS : null];
    const next = times.filter((t): t is number => t !== null);
    return next.length ? Math.min(...next) : null;
  }

  view(now: number): PilotView {
    return {
      id: this.pilot?.id ?? null,
      name: this.pilot?.name ?? null,
      idle: !!this.pilot && this.idle(now),
      away: this.awaySince !== null,
      typing: this.typingUntil > now,
      requests: this.queue.map(({ id, name, at }) => ({ id, name, at })),
      handFrom: this.queue.length ? this.frontSince : null,
      handAt: this.handAt(),
      last: this.last,
      declined: this.declined,
      now,
    };
  }

  private idle(now: number) {
    return now - this.lastUse >= PILOT_IDLE_MS && this.typingUntil <= now;
  }

  /** When the first asker gets the seat by itself: a short countdown, kept clear of the pilot's last question. */
  private handAt(): number | null {
    if (!this.pilot || !this.queue.length || this.awaySince !== null) return null;
    return Math.max(this.frontSince + PILOT_ANSWER_MS, this.lastUse + PILOT_RECENT_MS, this.typingUntil);
  }

  private hand(to: Who | null, how: How, now: number) {
    const from = this.pilot;
    this.pilot = to ? { id: to.id, name: to.name } : null;
    if (to) this.queue = this.queue.filter((q) => q.id !== to.id);
    this.frontSince = now;
    // The new pilot gets a moment with the seat before anyone's countdown can take it.
    this.lastUse = now;
    this.typingUntil = 0;
    this.awaySince = null;
    this.declined = null;
    this.last = { fromId: from?.id ?? null, from: from?.name ?? null, toId: to?.id ?? null, to: to?.name ?? null, how, at: now };
  }
}
